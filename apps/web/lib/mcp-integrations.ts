import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveOpenClawStateDir } from "@/lib/workspace";

// MCP-based integrations registry.
//
// Each integration here is a remote MCP server we surface in the DenchClaw
// integrations UI as a "Connect" affordance. The OAuth flow is the
// provider's own, so the user grants only the scopes their own account has
// — no third-party umbrella app.
//
// Phase 1 ships HubSpot; the file is structured so adding more providers
// is just another entry in INTEGRATIONS.

export type McpIntegrationId = "hubspot";

export type McpIntegrationDefinition = {
  id: McpIntegrationId;
  label: string;
  mcpServerUrl: string;
  authorizeUrl: string;
  tokenUrl: string;
  // Env var names the deployment owner sets in Render. The actual client
  // credentials live there, not in our state file.
  clientIdEnv: string;
  clientSecretEnv: string;
  // Space-separated default scopes. Override at connect time if you need
  // narrower or broader.
  defaultScopes: string;
};

export const INTEGRATIONS: Record<McpIntegrationId, McpIntegrationDefinition> = {
  hubspot: {
    id: "hubspot",
    label: "HubSpot",
    mcpServerUrl: "https://mcp.hubspot.com/",
    authorizeUrl: "https://mcp.hubspot.com/oauth/authorize/user",
    tokenUrl: "https://mcp.hubspot.com/oauth/v3/token",
    clientIdEnv: "HUBSPOT_OAUTH_CLIENT_ID",
    clientSecretEnv: "HUBSPOT_OAUTH_CLIENT_SECRET",
    // HubSpot scopes are configured on the developer app; the OAuth flow
    // accepts a `scope` param that must be a subset. Leaving this empty
    // lets HubSpot grant the union the app is registered for.
    defaultScopes: "",
  },
};

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const TOKENS_FILENAME = "mcp-tokens.json";
const OAUTH_STATE_FILENAME = "mcp-oauth-state.json";
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export type McpTokenRecord = {
  integration: McpIntegrationId;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenType: string;
  scope?: string;
  hubId?: string;
  userId?: string;
  userEmail?: string;
  connectedAt: string;
};

type TokensFile = {
  version: 1;
  integrations: Partial<Record<McpIntegrationId, McpTokenRecord>>;
};

type OAuthStateEntry = {
  integration: McpIntegrationId;
  codeVerifier: string;
  redirectUri: string;
  createdAt: number;
};

type OAuthStateFile = {
  version: 1;
  states: Record<string, OAuthStateEntry>;
};

function tokensPath(): string {
  return join(resolveOpenClawStateDir(), TOKENS_FILENAME);
}

function oauthStatePath(): string {
  return join(resolveOpenClawStateDir(), OAUTH_STATE_FILENAME);
}

function ensureStateDir(): void {
  const dir = resolveOpenClawStateDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function readJsonFile<T>(path: string, fallback: T): T {
  if (!existsSync(path)) {
    return fallback;
  }
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function writeJsonFile(path: string, value: unknown): void {
  ensureStateDir();
  writeFileSync(path, JSON.stringify(value, null, 2), "utf-8");
}

export function readMcpToken(id: McpIntegrationId): McpTokenRecord | null {
  const file = readJsonFile<TokensFile>(tokensPath(), { version: 1, integrations: {} });
  return file.integrations?.[id] ?? null;
}

export function writeMcpToken(id: McpIntegrationId, record: McpTokenRecord): void {
  const file = readJsonFile<TokensFile>(tokensPath(), { version: 1, integrations: {} });
  file.version = 1;
  file.integrations = { ...file.integrations, [id]: record };
  writeJsonFile(tokensPath(), file);
}

export function clearMcpToken(id: McpIntegrationId): void {
  const file = readJsonFile<TokensFile>(tokensPath(), { version: 1, integrations: {} });
  if (file.integrations) {
    const next = { ...file.integrations };
    delete next[id];
    file.integrations = next;
  }
  writeJsonFile(tokensPath(), file);
}

// ---------------------------------------------------------------------------
// PKCE + OAuth state handshake
// ---------------------------------------------------------------------------

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function createPkcePair(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = base64url(randomBytes(48));
  const codeChallenge = base64url(createHash("sha256").update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
}

export function createStateToken(): string {
  return base64url(randomBytes(24));
}

function pruneStaleStates(file: OAuthStateFile): OAuthStateFile {
  const now = Date.now();
  const next: Record<string, OAuthStateEntry> = {};
  for (const [k, v] of Object.entries(file.states ?? {})) {
    if (now - v.createdAt < OAUTH_STATE_TTL_MS) {
      next[k] = v;
    }
  }
  return { version: 1, states: next };
}

export function rememberOAuthState(state: string, entry: Omit<OAuthStateEntry, "createdAt">): void {
  const file = readJsonFile<OAuthStateFile>(oauthStatePath(), { version: 1, states: {} });
  const pruned = pruneStaleStates(file);
  pruned.states[state] = { ...entry, createdAt: Date.now() };
  writeJsonFile(oauthStatePath(), pruned);
}

export function consumeOAuthState(state: string): OAuthStateEntry | null {
  const file = readJsonFile<OAuthStateFile>(oauthStatePath(), { version: 1, states: {} });
  const pruned = pruneStaleStates(file);
  const entry = pruned.states[state];
  if (!entry) {
    writeJsonFile(oauthStatePath(), pruned);
    return null;
  }
  delete pruned.states[state];
  writeJsonFile(oauthStatePath(), pruned);
  return entry;
}

// ---------------------------------------------------------------------------
// Client-credential resolution
// ---------------------------------------------------------------------------

export function resolveClientCredentials(
  id: McpIntegrationId,
): { clientId: string; clientSecret: string } | null {
  const def = INTEGRATIONS[id];
  const clientId = process.env[def.clientIdEnv]?.trim();
  const clientSecret = process.env[def.clientSecretEnv]?.trim();
  if (!clientId || !clientSecret) {
    return null;
  }
  return { clientId, clientSecret };
}

// ---------------------------------------------------------------------------
// Authorize URL + token exchange
// ---------------------------------------------------------------------------

export function buildAuthorizeUrl(params: {
  integration: McpIntegrationId;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scopes?: string;
}): string {
  const def = INTEGRATIONS[params.integration];
  const url = new URL(def.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  const scope = params.scopes ?? def.defaultScopes;
  if (scope) {
    url.searchParams.set("scope", scope);
  }
  return url.toString();
}

export type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  hub_id?: string | number;
  user_id?: string | number;
  user?: string;
};

export async function exchangeCodeForToken(params: {
  integration: McpIntegrationId;
  clientId: string;
  clientSecret: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<TokenResponse> {
  const def = INTEGRATIONS[params.integration];
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: params.clientId,
    client_secret: params.clientSecret,
    code_verifier: params.codeVerifier,
  });
  const res = await fetch(def.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `Token exchange failed for ${params.integration} (HTTP ${res.status})${detail ? `: ${detail.slice(0, 300)}` : ""}`,
    );
  }
  return (await res.json()) as TokenResponse;
}

export function tokenResponseToRecord(
  id: McpIntegrationId,
  res: TokenResponse,
): McpTokenRecord {
  const now = Date.now();
  return {
    integration: id,
    accessToken: res.access_token,
    refreshToken: res.refresh_token,
    expiresAt: typeof res.expires_in === "number" ? now + res.expires_in * 1000 : undefined,
    tokenType: res.token_type ?? "Bearer",
    scope: res.scope,
    hubId: res.hub_id != null ? String(res.hub_id) : undefined,
    userId: res.user_id != null ? String(res.user_id) : undefined,
    userEmail: res.user,
    connectedAt: new Date(now).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// MCP plugin registration in openclaw.json
// ---------------------------------------------------------------------------
//
// OpenClaw reads remote MCP servers from `mcp.servers.<name>` in
// /data/.openclaw-dench/openclaw.json. The streamable-http transport
// matches HubSpot's MCP server. We rewrite the entry on every connect so
// token refreshes propagate without manual editing.

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function openClawConfigPath(): string {
  return join(resolveOpenClawStateDir(), "openclaw.json");
}

function readOpenClawConfig(): UnknownRecord {
  return readJsonFile<UnknownRecord>(openClawConfigPath(), {});
}

function writeOpenClawConfig(config: UnknownRecord): void {
  writeJsonFile(openClawConfigPath(), config);
}

export function registerMcpServer(params: {
  name: string;
  url: string;
  accessToken: string;
  transport?: "streamable-http" | "sse";
}): void {
  const config = readOpenClawConfig();
  const mcp = asRecord(config.mcp) ?? {};
  const servers = asRecord(mcp.servers) ?? {};
  servers[params.name] = {
    url: params.url,
    transport: params.transport ?? "streamable-http",
    headers: {
      Authorization: `Bearer ${params.accessToken}`,
    },
  };
  mcp.servers = servers;
  config.mcp = mcp;
  writeOpenClawConfig(config);
}

export function unregisterMcpServer(name: string): void {
  const config = readOpenClawConfig();
  const mcp = asRecord(config.mcp);
  const servers = asRecord(mcp?.servers);
  if (!mcp || !servers || !(name in servers)) {
    return;
  }
  const next = { ...servers };
  delete next[name];
  mcp.servers = next;
  config.mcp = mcp;
  writeOpenClawConfig(config);
}

// ---------------------------------------------------------------------------
// Public status view (used by the integrations UI + API)
// ---------------------------------------------------------------------------

export type McpIntegrationStatus = {
  id: McpIntegrationId;
  label: string;
  available: boolean;
  configured: boolean;
  connected: boolean;
  missingEnv: string[];
  connection: {
    connectedAt: string;
    expiresAt?: number;
    scope?: string;
    userEmail?: string;
    hubId?: string;
  } | null;
};

export function getMcpIntegrationStatus(id: McpIntegrationId): McpIntegrationStatus {
  const def = INTEGRATIONS[id];
  const creds = resolveClientCredentials(id);
  const token = readMcpToken(id);
  const missingEnv: string[] = [];
  if (!process.env[def.clientIdEnv]?.trim()) missingEnv.push(def.clientIdEnv);
  if (!process.env[def.clientSecretEnv]?.trim()) missingEnv.push(def.clientSecretEnv);
  return {
    id,
    label: def.label,
    available: true,
    configured: creds !== null,
    connected: token !== null,
    missingEnv,
    connection: token
      ? {
          connectedAt: token.connectedAt,
          expiresAt: token.expiresAt,
          scope: token.scope,
          userEmail: token.userEmail,
          hubId: token.hubId,
        }
      : null,
  };
}

export function listMcpIntegrationStatus(): McpIntegrationStatus[] {
  return (Object.keys(INTEGRATIONS) as McpIntegrationId[]).map(getMcpIntegrationStatus);
}
