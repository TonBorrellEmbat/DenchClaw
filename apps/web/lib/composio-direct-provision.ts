/**
 * Boot-time provisioner for non-OAuth Composio connections.
 *
 * Some providers (HubSpot via Private App PAT, Gong via API key + secret)
 * are credentialed once via Render env vars and never go through the UI's
 * OAuth flow. On every Next.js server start we make sure their Composio
 * resources exist and that openclaw.json points at the right MCP server, so
 * the agent's toolset is identical across redeploys/disk wipes without any
 * human Connect button.
 *
 * For OAuth-based providers (Gmail, Drive, ...), the existing UI flow in
 * `composio.ts` still owns provisioning — they're left untouched here.
 */

import {
  registerComposioMcpInOpenClaw,
  resolveComposioGatewayUrl,
} from "./composio";

type DirectAuthScheme = "API_KEY" | "BASIC";

interface DirectProviderSpec {
  toolkitSlug: string;
  authConfigName: string;
  mcpServerName: string;
  authScheme: DirectAuthScheme;
  allowedTools: string[];
  /**
   * Read credentials from Render env vars. Returns the `val` object Composio
   * expects on `connected_accounts.state.val`, or null if env vars are missing.
   */
  readCredentials(): Record<string, string> | null;
}

const HUBSPOT_READ_TOOLS = [
  "HUBSPOT_LIST_CONTACTS",
  "HUBSPOT_READ_CONTACT",
  "HUBSPOT_READ_CONTACTS",
  "HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA",
  "HUBSPOT_LIST_CONTACT_PROPERTIES",
  "HUBSPOT_LIST_COMPANIES",
  "HUBSPOT_GET_COMPANY",
  "HUBSPOT_SEARCH_COMPANIES",
  "HUBSPOT_BATCH_READ_COMPANIES_BY_PROPERTIES",
  "HUBSPOT_LIST_DEALS",
  "HUBSPOT_GET_DEAL",
  "HUBSPOT_GET_DEALS",
  "HUBSPOT_SEARCH_DEALS",
  "HUBSPOT_GET_PIPELINE_BY_ID",
  "HUBSPOT_GET_ACCOUNT_INFO",
];

const GONG_READ_TOOLS = [
  "GONG_RETRIEVE_CALL_DATA_BY_DATE_RANGE_V2_CALLS",
  "GONG_RETRIEVE_FILTERED_CALL_DETAILS",
  "GONG_GET_CALL_BY_ID",
  "GONG_GET_CALL_TRANSCRIPT",
  "GONG_LIST_ALL_USERS_V2_USERS",
  "GONG_LIST_USERS_BY_FILTER_V2_USERS_EXTENSIVE",
  "GONG_GET_USER_BY_ID",
  "GONG_LIST_ALL_COMPANY_WORKSPACES_V2_WORKSPACES",
  "GONG_GET_INTERACTION_STATISTICS",
  "GONG_AGGREGATE_ACTIVITY_BY_PERIOD_VIA_API",
  "GONG_AGGREGATE_USER_ACTIVITY_STATISTICS",
  "GONG_POST_DAY_BY_DAY_ACTIVITY_STATS",
  "GONG_LIST_SCORECARDS",
  "GONG_LIST_CALL_OUTCOMES",
  "GONG_LIST_FOLDER_CALLS",
  "GONG_RETRIEVE_LIBRARY_FOLDERS_V2_LIBRARY_FOLDERS",
];

const HUBSPOT_PROVIDER: DirectProviderSpec = {
  toolkitSlug: "hubspot",
  authConfigName: "alphadench-hubspot-api-key",
  mcpServerName: "alphadench-hubspot-apikey",
  authScheme: "API_KEY",
  allowedTools: HUBSPOT_READ_TOOLS,
  readCredentials() {
    const token = process.env.HUBSPOT_PRIVATE_APP_TOKEN?.trim();
    if (!token) {
      return null;
    }
    return { generic_api_key: token };
  },
};

const GONG_PROVIDER: DirectProviderSpec = {
  toolkitSlug: "gong",
  authConfigName: "alphadench-gong-basic",
  mcpServerName: "alphadench-gong",
  authScheme: "BASIC",
  allowedTools: GONG_READ_TOOLS,
  readCredentials() {
    const username = process.env.GONG_ACCESS_KEY?.trim();
    const password = process.env.GONG_ACCESS_SECRET?.trim();
    const full = process.env.GONG_API_BASE_URL?.trim() || "https://api.gong.io";
    if (!username || !password) {
      return null;
    }
    return { username, password, full };
  },
};

const PROVIDERS: DirectProviderSpec[] = [HUBSPOT_PROVIDER, GONG_PROVIDER];

const USER_ID = "default";

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

async function gatewayFetch(
  gatewayUrl: string,
  apiKey: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const url = `${gatewayUrl.replace(/\/$/, "")}${path}`;
  const extraHeaders = (init?.headers ?? {}) as Record<string, string>;
  return fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      ...extraHeaders,
    },
  });
}

async function ensureAuthConfig(
  gatewayUrl: string,
  apiKey: string,
  provider: DirectProviderSpec,
): Promise<string> {
  const listParams = new URLSearchParams({
    toolkit_slugs: provider.toolkitSlug,
    limit: "50",
  });
  const listRes = await gatewayFetch(
    gatewayUrl,
    apiKey,
    `/api/v3.1/auth_configs?${listParams.toString()}`,
  );
  if (listRes.ok) {
    const body = (await listRes.json()) as UnknownRecord;
    const items = Array.isArray(body.items) ? body.items : [];
    for (const raw of items) {
      const item = asRecord(raw);
      const id = readString(item?.id);
      const name = readString(item?.name);
      const scheme = readString(item?.auth_scheme);
      if (id && name === provider.authConfigName && scheme === provider.authScheme) {
        return id;
      }
    }
  }

  const createRes = await gatewayFetch(
    gatewayUrl,
    apiKey,
    "/api/v3.1/auth_configs",
    {
      method: "POST",
      body: JSON.stringify({
        toolkit: { slug: provider.toolkitSlug },
        auth_config: {
          name: provider.authConfigName,
          type: "use_custom_auth",
          authScheme: provider.authScheme,
          credentials: {},
        },
      }),
    },
  );
  if (!createRes.ok) {
    throw new Error(
      `auth_config create failed (HTTP ${createRes.status}): ${await createRes.text()}`,
    );
  }
  const created = (await createRes.json()) as UnknownRecord;
  const authConfig = asRecord(created.auth_config);
  const id = readString(authConfig?.id);
  if (!id) {
    throw new Error("auth_config create returned no id");
  }
  return id;
}

async function findActiveConnection(
  gatewayUrl: string,
  apiKey: string,
  provider: DirectProviderSpec,
  authConfigId: string,
): Promise<string | null> {
  const params = new URLSearchParams({
    auth_config_ids: authConfigId,
    user_ids: USER_ID,
    limit: "20",
  });
  const res = await gatewayFetch(
    gatewayUrl,
    apiKey,
    `/api/v3.1/connected_accounts?${params.toString()}`,
  );
  if (!res.ok) {
    return null;
  }
  const body = (await res.json()) as UnknownRecord;
  const items = Array.isArray(body.items) ? body.items : [];
  for (const raw of items) {
    const item = asRecord(raw);
    const status = readString(item?.status);
    const id = readString(item?.id);
    if (id && status === "ACTIVE") {
      return id;
    }
  }
  return null;
}

async function ensureConnectedAccount(
  gatewayUrl: string,
  apiKey: string,
  provider: DirectProviderSpec,
  authConfigId: string,
  credentials: Record<string, string>,
): Promise<void> {
  const existing = await findActiveConnection(
    gatewayUrl,
    apiKey,
    provider,
    authConfigId,
  );
  if (existing) {
    return;
  }

  const createRes = await gatewayFetch(
    gatewayUrl,
    apiKey,
    "/api/v3.1/connected_accounts",
    {
      method: "POST",
      body: JSON.stringify({
        auth_config: { id: authConfigId },
        connection: {
          user_id: USER_ID,
          state: {
            authScheme: provider.authScheme,
            val: {
              status: "ACTIVE",
              ...credentials,
            },
          },
        },
      }),
    },
  );
  if (!createRes.ok) {
    throw new Error(
      `connected_account create failed (HTTP ${createRes.status}): ${await createRes.text()}`,
    );
  }
}

async function ensureMcpServer(
  gatewayUrl: string,
  apiKey: string,
  provider: DirectProviderSpec,
  authConfigId: string,
): Promise<string> {
  const listParams = new URLSearchParams({
    auth_config_ids: authConfigId,
    limit: "50",
  });
  const listRes = await gatewayFetch(
    gatewayUrl,
    apiKey,
    `/api/v3.1/mcp/servers?${listParams.toString()}`,
  );
  if (listRes.ok) {
    const body = (await listRes.json()) as UnknownRecord;
    const items = Array.isArray(body.items) ? body.items : [];
    for (const raw of items) {
      const item = asRecord(raw);
      const name = readString(item?.name);
      const mcpUrl = readString(item?.mcp_url);
      if (name === provider.mcpServerName && mcpUrl) {
        return mcpUrl;
      }
    }
  }

  const createRes = await gatewayFetch(
    gatewayUrl,
    apiKey,
    "/api/v3.1/mcp/servers",
    {
      method: "POST",
      body: JSON.stringify({
        name: provider.mcpServerName,
        auth_config_ids: [authConfigId],
        allowed_tools: provider.allowedTools,
        managed_auth_via_composio: false,
      }),
    },
  );
  if (!createRes.ok) {
    throw new Error(
      `mcp/servers create failed (HTTP ${createRes.status}): ${await createRes.text()}`,
    );
  }
  const created = (await createRes.json()) as UnknownRecord;
  const mcpUrl = readString(created.mcp_url);
  if (!mcpUrl) {
    throw new Error("mcp/servers create returned no mcp_url");
  }
  return mcpUrl;
}

// Direct stdout write — Next.js standalone occasionally swallows console.log
// from the instrumentation hook so we surface progress via the same channel
// the AlphaClaw bootstrap uses (visible in Render's app logs).
function log(line: string): void {
  process.stdout.write(`[composio-direct] ${line}\n`);
}

/**
 * Run on Next.js server boot. Best-effort; per-provider failures don't block
 * the rest of the providers and don't block server startup. Also drops a
 * status file at /data/.openclaw-dench/composio-direct-status.json so we can
 * inspect results without shell access.
 */
export async function provisionDirectComposioConnections(): Promise<void> {
  log("starting");
  const status: UnknownRecord = {
    ranAt: new Date().toISOString(),
    providers: {} as Record<string, unknown>,
  };
  const writeStatus = (): void => {
    try {
      const fs = require("node:fs") as typeof import("node:fs");
      const path = require("node:path") as typeof import("node:path");
      const { resolveOpenClawStateDir } = require("@/lib/workspace") as {
        resolveOpenClawStateDir: () => string;
      };
      const out = path.join(
        resolveOpenClawStateDir(),
        "composio-direct-status.json",
      );
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, JSON.stringify(status, null, 2), "utf-8");
    } catch (err) {
      log(`status write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const apiKey = process.env.COMPOSIO_API_KEY?.trim();
  if (!apiKey) {
    log("COMPOSIO_API_KEY not set, skipping");
    status.skipped = "no-api-key";
    writeStatus();
    return;
  }
  const gatewayUrl = resolveComposioGatewayUrl();

  for (const provider of PROVIDERS) {
    const providerStatus: UnknownRecord = {};
    (status.providers as Record<string, unknown>)[provider.toolkitSlug] =
      providerStatus;

    const credentials = provider.readCredentials();
    if (!credentials) {
      log(`${provider.toolkitSlug}: env vars not set, skipping`);
      providerStatus.skipped = "no-credentials";
      continue;
    }
    try {
      log(`${provider.toolkitSlug}: ensuring auth_config`);
      const authConfigId = await ensureAuthConfig(gatewayUrl, apiKey, provider);
      providerStatus.authConfigId = authConfigId;

      log(`${provider.toolkitSlug}: ensuring connected_account`);
      await ensureConnectedAccount(
        gatewayUrl,
        apiKey,
        provider,
        authConfigId,
        credentials,
      );

      log(`${provider.toolkitSlug}: ensuring mcp server`);
      const mcpUrl = await ensureMcpServer(
        gatewayUrl,
        apiKey,
        provider,
        authConfigId,
      );
      providerStatus.mcpUrl = mcpUrl;

      registerComposioMcpInOpenClaw({
        toolkitSlug: provider.toolkitSlug,
        mcpUrl,
        userId: USER_ID,
        apiKeyEnvVar: "COMPOSIO_API_KEY",
      });
      providerStatus.registered = true;
      log(
        `${provider.toolkitSlug}: provisioned ${provider.mcpServerName} -> ${mcpUrl}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      providerStatus.error = msg;
      log(`${provider.toolkitSlug} failed: ${msg}`);
    }
  }
  writeStatus();
  log("done");
}
