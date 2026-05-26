import { normalizeComposioToolkitSlug } from "@/lib/composio-normalization";

// Direct Composio base URL. We've stripped out the Dench Cloud gateway proxy
// so the integrations UI talks to Composio's public REST API with the user's
// own COMPOSIO_API_KEY. The variable name still says "gateway" because too
// many call sites reference it; treat it as the Composio API base.
const DEFAULT_GATEWAY_URL = "https://backend.composio.dev";

// Composio "user_id" partition for this single-tenant deployment. Connected
// accounts are stored under this id; if you ever multi-tenant this fork,
// derive it from the request session instead.
const COMPOSIO_DEFAULT_USER_ID = "default";

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function pickString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const parsed = readString(value);
    if (parsed) {
      return parsed;
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ComposioToolkit = {
  slug: string;
  connect_slug?: string | null;
  name: string;
  description: string;
  logo: string | null;
  categories: string[];
  auth_schemes: string[];
  tools_count: number;
};

export type ComposioToolkitRecord = {
  slug?: string | null;
  name?: string | null;
  description?: string | null;
  description_short?: string | null;
  summary?: string | null;
  logo?: string | null;
  logo_url?: string | null;
  icon?: string | null;
  image?: string | null;
  categories?: string[] | null;
  auth_schemes?: string[] | null;
  authSchemes?: string[] | null;
  tools_count?: number | null;
  toolsCount?: number | null;
  meta?: {
    logo?: string | null;
    description?: string | null;
    categories?: string[] | null;
    [key: string]: unknown;
  } | null;
};

export type ComposioIdentityConfidence = "high" | "low" | "unknown";
export type ComposioReconnectClaim = "same" | "different" | "unknown";
export type ComposioReconnectConfidence = "high" | "unknown";

export type ComposioConnectionToolkit = {
  slug?: string | null;
  name?: string | null;
};

export type ComposioConnectionRawIds = {
  externalAccountId?: string | null;
  providerAccountId?: string | null;
  providerUserId?: string | null;
  workspaceId?: string | null;
  teamId?: string | null;
  tenantId?: string | null;
  organizationId?: string | null;
};

export type ComposioConnectionAccount = {
  stableId?: string | null;
  confidence?: ComposioIdentityConfidence;
  label?: string | null;
  email?: string | null;
  avatarUrl?: string | null;
  rawIds?: ComposioConnectionRawIds;
};

export type ComposioConnectionReconnect = {
  claim?: ComposioReconnectClaim;
  confidence?: ComposioReconnectConfidence;
  relatedConnectionIds?: string[];
};

export type ComposioConnectionRecord = {
  id?: string | null;
  connectionId?: string | null;
  toolkit_slug?: string | null;
  toolkit_name?: string | null;
  toolkit?: ComposioConnectionToolkit;
  status?: string | null;
  created_at?: string | null;
  createdAt?: string | null;
  updated_at?: string | null;
  updatedAt?: string | null;
  account_label?: string | null;
  account_name?: string | null;
  account_email?: string | null;
  external_account_id?: string | null;
  account_stable_id?: string | null;
  account?: ComposioConnectionAccount;
  reconnect?: ComposioConnectionReconnect;
};

export type ComposioConnection = {
  id: string;
  toolkit_slug: string;
  toolkit_name: string;
  status: "ACTIVE" | "INITIATED" | "EXPIRED" | "FAILED" | "INACTIVE" | string;
  created_at: string;
  updated_at?: string | null;
  account_label?: string | null;
  account_name?: string | null;
  account_email?: string | null;
  external_account_id?: string | null;
  account_stable_id?: string | null;
  toolkit?: ComposioConnectionToolkit;
  account?: ComposioConnectionAccount;
  reconnect?: ComposioConnectionReconnect;
};

export type ComposioToolkitsResponse = {
  items: ComposioToolkitRecord[];
  cursor?: string | null;
  total?: number;
  categories?: string[];
  toolkits?: ComposioToolkitRecord[];
  data?: ComposioToolkitRecord[];
  next_cursor?: string | null;
  nextCursor?: string | null;
  total_items?: number;
};

export type ComposioConnectionsResponse = {
  items?: ComposioConnectionRecord[];
  connections?: ComposioConnectionRecord[];
  raw?: unknown;
};

export type ComposioConnectResponse = {
  redirect_url: string;
  connection_id: string | null;
};

export type ComposioState = {
  eligible: boolean;
  lockReason: "missing_dench_key" | "dench_not_primary" | null;
  lockBadge: string | null;
  toolkits: ComposioToolkit[];
  connections: ComposioConnection[];
  categories: string[];
};

export type NormalizedComposioConnection = ComposioConnection & {
  normalized_toolkit_slug: string;
  normalized_status: string;
  is_active: boolean;
  account_identity: string;
  account_identity_source: "gateway_stable_id" | "legacy_heuristic" | "connection_id";
  identity_confidence: ComposioIdentityConfidence;
  display_label: string;
  reconnect_claim: ComposioReconnectClaim;
  reconnect_confidence: ComposioReconnectConfidence;
  related_connection_ids: string[];
  is_same_account_reconnect: boolean;
};

export function normalizeComposioConnectionStatus(status: unknown): string {
  return typeof status === "string" && status.trim()
    ? status.trim().toUpperCase()
    : "UNKNOWN";
}

function buildComposioConnectionDisplayLabel(connection: ComposioConnection): string {
  const label = [
    connection.account_label,
    connection.account_name,
    connection.account_email,
    connection.account?.label,
    connection.account?.email,
  ].find((value) => typeof value === "string" && value.trim());

  if (label) {
    return label;
  }

  return `Connection ${connection.id.slice(-6)}`;
}

function buildComposioConnectionIdentity(connection: ComposioConnection): {
  value: string;
  source: "gateway_stable_id" | "legacy_heuristic" | "connection_id";
  confidence: ComposioIdentityConfidence;
} {
  const gatewayStableId = pickString(
    connection.account_stable_id,
    connection.account?.stableId,
  );
  if (gatewayStableId) {
    return {
      value: gatewayStableId,
      source: "gateway_stable_id",
      confidence: connection.account?.confidence ?? "high",
    };
  }

  const stableIdentity = [
    connection.external_account_id,
    connection.account_email,
    connection.account_name,
    connection.account_label,
  ].find((value) => typeof value === "string" && value.trim());

  if (stableIdentity) {
    return {
      value: `${normalizeComposioToolkitSlug(connection.toolkit_slug)}:${stableIdentity.trim().toLowerCase()}`,
      source: "legacy_heuristic",
      confidence: connection.external_account_id ? "high" : "low",
    };
  }

  return {
    value: `${normalizeComposioToolkitSlug(connection.toolkit_slug)}:${connection.id}`,
    source: "connection_id",
    confidence: "unknown",
  };
}

export function normalizeComposioConnection(
  connection: ComposioConnection,
): NormalizedComposioConnection {
  const normalized_status = normalizeComposioConnectionStatus(connection.status);
  const identity = buildComposioConnectionIdentity(connection);
  const reconnect_claim = connection.reconnect?.claim ?? "unknown";
  const reconnect_confidence = connection.reconnect?.confidence ?? "unknown";
  const related_connection_ids = connection.reconnect?.relatedConnectionIds ?? [];

  return {
    ...connection,
    normalized_toolkit_slug: normalizeComposioToolkitSlug(connection.toolkit_slug),
    normalized_status,
    is_active: normalized_status === "ACTIVE",
    account_identity: identity.value,
    account_identity_source: identity.source,
    identity_confidence: identity.confidence,
    display_label: buildComposioConnectionDisplayLabel(connection),
    reconnect_claim,
    reconnect_confidence,
    related_connection_ids,
    is_same_account_reconnect:
      reconnect_claim === "same" && reconnect_confidence === "high",
  };
}

function parseComposioConnectionTime(connection: ComposioConnection): number {
  const timestamp = Date.parse(connection.created_at);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function sortComposioConnections(
  left: NormalizedComposioConnection,
  right: NormalizedComposioConnection,
): number {
  if (left.is_active !== right.is_active) {
    return left.is_active ? -1 : 1;
  }

  const timeDiff = parseComposioConnectionTime(right) - parseComposioConnectionTime(left);
  if (timeDiff !== 0) {
    return timeDiff;
  }

  return left.display_label.localeCompare(right.display_label);
}

export function normalizeComposioConnections(
  connections: ComposioConnection[],
): NormalizedComposioConnection[] {
  return connections.map(normalizeComposioConnection).sort(sortComposioConnections);
}

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

export function resolveComposioGatewayUrl(): string {
  return (
    process.env.COMPOSIO_BASE_URL?.trim() ||
    process.env.DENCH_GATEWAY_URL?.trim() ||
    DEFAULT_GATEWAY_URL
  );
}

export function resolveComposioApiKey(): string | null {
  return (
    process.env.COMPOSIO_API_KEY?.trim() ||
    process.env.DENCH_CLOUD_API_KEY?.trim() ||
    process.env.DENCH_API_KEY?.trim() ||
    null
  );
}

export function resolveComposioEligibility(): {
  eligible: boolean;
  lockReason: "missing_dench_key" | "dench_not_primary" | null;
  lockBadge: string | null;
} {
  if (!resolveComposioApiKey()) {
    return {
      eligible: false,
      lockReason: "missing_dench_key",
      lockBadge: "Add Composio API Key",
    };
  }
  return { eligible: true, lockReason: null, lockBadge: null };
}

// ---------------------------------------------------------------------------
// Gateway client helpers
// ---------------------------------------------------------------------------

async function gatewayFetch(
  gatewayUrl: string,
  apiKey: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const url = `${gatewayUrl.replace(/\/$/, "")}${path}`;
  return fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      ...init?.headers,
    },
  });
}

export type FetchToolkitsOptions = {
  search?: string;
  category?: string;
  cursor?: string;
  limit?: number;
};

function normalizeToolkitsEnvelope(raw: ComposioToolkitsResponse): ComposioToolkitsResponse {
  const items = raw.items?.length
    ? raw.items
    : raw.toolkits?.length
      ? raw.toolkits
      : raw.data ?? [];
  const cursor = raw.cursor ?? raw.next_cursor ?? raw.nextCursor ?? null;
  const total = raw.total ?? raw.total_items;
  return {
    items,
    cursor,
    total,
    categories: raw.categories,
  };
}

export async function fetchComposioToolkits(
  gatewayUrl: string,
  apiKey: string,
  options?: FetchToolkitsOptions,
): Promise<ComposioToolkitsResponse> {
  const params = new URLSearchParams();
  if (options?.search) params.set("search", options.search);
  if (options?.category) params.set("category", options.category);
  if (options?.cursor) params.set("cursor", options.cursor);
  if (options?.limit) params.set("limit", String(options.limit));
  const qs = params.toString();
  const path = `/api/v3.1/toolkits${qs ? `?${qs}` : ""}`;
  const res = await gatewayFetch(gatewayUrl, apiKey, path);
  if (!res.ok) {
    throw new Error(`Failed to fetch toolkits (HTTP ${res.status})`);
  }
  const raw = (await res.json()) as ComposioToolkitsResponse;
  return normalizeToolkitsEnvelope(raw);
}

export async function fetchComposioConnections(
  gatewayUrl: string,
  apiKey: string,
): Promise<ComposioConnectionsResponse> {
  const res = await gatewayFetch(gatewayUrl, apiKey, "/api/v3.1/connected_accounts");
  if (!res.ok) {
    throw new Error(`Failed to fetch connections (HTTP ${res.status})`);
  }
  return res.json() as Promise<ComposioConnectionsResponse>;
}

/**
 * Per-toolkit "starter" tool sets used to narrow the OAuth scopes requested
 * during connect. Composio computes the minimum scopes needed for the listed
 * tools and uses ONLY those — so the consent screen drops from "everything"
 * to just what the listed tools actually need.
 *
 * If a toolkit isn't in this map, Composio falls back to its managed-auth
 * default (the broad superset), which is what we had before.
 *
 * Edit these lists to widen/narrow the agent's surface; the next connect
 * picks the new set up automatically.
 */
const COMPOSIO_TOOLKIT_TOOL_PRESETS: Record<string, string[]> = {
  hubspot: [
    // Contacts
    "HUBSPOT_LIST_CONTACTS",
    "HUBSPOT_READ_CONTACT",
    "HUBSPOT_READ_CONTACTS",
    "HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA",
    "HUBSPOT_LIST_CONTACT_PROPERTIES",
    // Companies
    "HUBSPOT_LIST_COMPANIES",
    "HUBSPOT_GET_COMPANY",
    "HUBSPOT_SEARCH_COMPANIES",
    "HUBSPOT_BATCH_READ_COMPANIES_BY_PROPERTIES",
    // Deals
    "HUBSPOT_LIST_DEALS",
    "HUBSPOT_GET_DEAL",
    "HUBSPOT_GET_DEALS",
    "HUBSPOT_SEARCH_DEALS",
    // Tickets
    "HUBSPOT_LIST_TICKETS",
    "HUBSPOT_GET_TICKET",
    "HUBSPOT_GET_TICKETS",
    "HUBSPOT_SEARCH_TICKETS",
    // Generic CRM object reads / cross-object associations / pipelines
    "HUBSPOT_READ_CRM_OBJECT_BY_ID",
    "HUBSPOT_SEARCH_CRM_OBJECTS_BY_CRITERIA",
    "HUBSPOT_READ_APAGE_OF_OBJECTS_BY_TYPE",
    "HUBSPOT_LIST_OBJECT_ASSOCIATIONS",
    "HUBSPOT_GET_PIPELINE_BY_ID",
    "HUBSPOT_GET_ACCOUNT_INFO",
    "HUBSPOT_LIST_GRANTED_SCOPES",
  ],
};

/**
 * Look up an existing Composio-managed auth_config for the toolkit, or create one.
 *
 * Composio requires an auth_config before you can create a connected_account.
 * When a preset of tools is defined for this toolkit we narrow the OAuth scopes
 * Composio requests via `tool_access_config.tools_for_connected_account_creation`.
 * Without that field, Composio's managed auth requests its full default scope
 * superset (which on HubSpot includes admin-level user management).
 *
 * Existing auth_configs that were created before scope narrowing are PATCHed
 * to the new tool list on the next connect, so a user re-trying after a
 * version bump gets the narrower consent screen automatically.
 */
async function ensureAuthConfigForToolkit(
  gatewayUrl: string,
  apiKey: string,
  toolkitSlug: string,
): Promise<string> {
  const presetTools = COMPOSIO_TOOLKIT_TOOL_PRESETS[toolkitSlug.toLowerCase()] ?? null;

  const listParams = new URLSearchParams({ toolkit_slugs: toolkitSlug, limit: "20" });
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
      if (id && readString(item?.toolkit_slug ?? asRecord(item?.toolkit)?.slug) === toolkitSlug) {
        if (presetTools && presetTools.length > 0) {
          // Realign existing auth_config to current preset. This is the path
          // that gets a user from "Composio asked for everything" to
          // "Composio asked for only the tools we listed" without having to
          // delete and re-create the auth_config by hand.
          await gatewayFetch(gatewayUrl, apiKey, `/api/v3.1/auth_configs/${encodeURIComponent(id)}`, {
            method: "PATCH",
            body: JSON.stringify({
              // Composio's PATCH endpoint discriminates by `type`; "default"
              // selects managed auth, "custom" selects BYO. Without `type`
              // the request 400s with "Invalid discriminator value".
              type: "default",
              tool_access_config: {
                tools_for_connected_account_creation: presetTools,
              },
            }),
          });
        }
        return id;
      }
    }
  }

  const createBody: UnknownRecord = {
    toolkit: { slug: toolkitSlug },
    auth_config: { type: "use_composio_managed_auth" },
  };
  if (presetTools && presetTools.length > 0) {
    (createBody.auth_config as UnknownRecord).tool_access_config = {
      tools_for_connected_account_creation: presetTools,
    };
  }
  const createRes = await gatewayFetch(gatewayUrl, apiKey, "/api/v3.1/auth_configs", {
    method: "POST",
    body: JSON.stringify(createBody),
  });
  if (!createRes.ok) {
    const detail = await createRes.text().catch(() => "");
    throw new Error(
      `Failed to create managed auth config for ${toolkitSlug} (HTTP ${createRes.status})${detail ? `: ${detail.slice(0, 300)}` : ""}`,
    );
  }
  const created = (await createRes.json()) as UnknownRecord;
  const id = readString(asRecord(created.auth_config)?.id) ?? readString(created.id);
  if (!id) {
    throw new Error(`Composio returned no auth_config id for ${toolkitSlug}`);
  }
  return id;
}

export async function initiateComposioConnect(
  gatewayUrl: string,
  apiKey: string,
  toolkit: string,
  callbackUrl: string,
): Promise<ComposioConnectResponse> {
  const authConfigId = await ensureAuthConfigForToolkit(gatewayUrl, apiKey, toolkit);

  // Composio-managed OAuth configs now require the `/link` endpoint —
  // POST /api/v3.1/connected_accounts returns
  // "Creating connections on this endpoint for Composio-managed OAuth auth
  // configs is no longer supported. Use POST /api/v3/connected_accounts/link
  // instead." The /link endpoint takes auth_config_id + user_id and returns a
  // redirect_url the browser can open.
  const res = await gatewayFetch(gatewayUrl, apiKey, "/api/v3/connected_accounts/link", {
    method: "POST",
    body: JSON.stringify({
      auth_config_id: authConfigId,
      user_id: COMPOSIO_DEFAULT_USER_ID,
      callback_url: callbackUrl,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `Failed to initiate connection for ${toolkit} (HTTP ${res.status})${detail ? `: ${detail}` : ""}`,
    );
  }

  // Normalize to the ComposioConnectResponse the UI expects: redirect URL +
  // connection id. The /link response shape uses `redirect_url` directly.
  const raw = (await res.json()) as UnknownRecord;
  const connectionData = asRecord(raw.connectionData);
  const connectionVal = asRecord(connectionData?.val);
  const redirectUrl =
    readString(raw.redirect_url) ??
    readString(raw.redirect_uri) ??
    readString(connectionVal?.redirectUrl) ??
    readString(connectionVal?.redirect_url) ??
    null;
  const id =
    readString(raw.connected_account_id) ??
    readString(raw.connection_id) ??
    readString(raw.id);

  return {
    ...(raw as object),
    connection_id: id ?? null,
    redirect_url: redirectUrl,
    toolkit,
  } as ComposioConnectResponse;
}

export type DisconnectComposioAppResult = {
  deleted: boolean;
  /**
   * True when the upstream connection was already gone (HTTP 404 from
   * Composio) before we tried to delete it. From the user's
   * perspective the intent is achieved either way, so we surface this
   * as success — the caller can decide whether to whisper "already
   * disconnected" in the UI vs. saying nothing at all.
   *
   * Without this, a stale localStorage cache showing a connection that
   * Composio revoked upstream produces a misleading "Failed to
   * disconnect (HTTP 404)" error when the user clicks Disconnect on a
   * row that's already history.
   */
  alreadyGone?: boolean;
};

export async function disconnectComposioApp(
  gatewayUrl: string,
  apiKey: string,
  connectionId: string,
): Promise<DisconnectComposioAppResult> {
  const res = await gatewayFetch(
    gatewayUrl,
    apiKey,
    `/api/v3.1/connected_accounts/${encodeURIComponent(connectionId)}`,
    { method: "DELETE" },
  );
  if (res.status === 404) {
    // Connection isn't on Composio anymore — either we revoked it on
    // their side (dashboard, support ticket) or the OAuth provider
    // pulled the rug. The local state needs cleaning up regardless,
    // and the caller's `refreshIntegrationsRuntime()` will re-sync the
    // gateway-visible truth into the rest of the app.
    return { deleted: true, alreadyGone: true };
  }
  if (!res.ok) {
    throw new Error(`Failed to disconnect (HTTP ${res.status})`);
  }
  // Some Composio responses return an empty body on successful DELETE
  // (typical REST behaviour); fall back to a synthesized success in
  // that case rather than surfacing "Unexpected end of JSON input".
  const body = await res.text().catch(() => "");
  if (!body.trim()) {
    return { deleted: true };
  }
  try {
    const parsed = JSON.parse(body) as Partial<DisconnectComposioAppResult>;
    return { deleted: parsed.deleted ?? true };
  } catch {
    return { deleted: true };
  }
}

// ---------------------------------------------------------------------------
// Composio MCP (Streamable HTTP) — tools/list for tool index builder
// ---------------------------------------------------------------------------

export type ComposioMcpTool = {
  name: string;
  description?: string;
  title?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
};

function extractToolsFromJsonRpcMessage(payload: unknown): {
  tools: ComposioMcpTool[];
  nextCursor: string | null;
} {
  const rec = asRecord(payload);
  const result = asRecord(rec?.result);
  const tools = result?.tools;
  if (!Array.isArray(tools)) {
    return {
      tools: [],
      nextCursor: readString(result?.next_cursor ?? result?.nextCursor ?? result?.cursor) ?? null,
    };
  }

  const out: ComposioMcpTool[] = [];
  for (const item of tools) {
    const t = asRecord(item);
    const name = readString(t?.name);
    if (!name) {
      continue;
    }
    out.push({
      name,
      description: readString(t?.description),
      title: readString(t?.title ?? asRecord(t?.annotations)?.title),
      inputSchema: t?.inputSchema as ComposioMcpTool["inputSchema"],
      annotations: t?.annotations as ComposioMcpTool["annotations"],
    });
  }
  return {
    tools: out,
    nextCursor: readString(result?.next_cursor ?? result?.nextCursor ?? result?.cursor) ?? null,
  };
}

function parseSseJsonRpcTools(body: string): {
  tools: ComposioMcpTool[];
  nextCursor: string | null;
} {
  const lines = body.split(/\r?\n/);
  let lastPayload: unknown = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) {
      continue;
    }
    const raw = trimmed.slice(5).trim();
    if (raw === "[DONE]" || raw === "") {
      continue;
    }
    try {
      lastPayload = JSON.parse(raw);
    } catch {
      // ignore non-JSON SSE frames
    }
  }
  if (lastPayload === null) {
    return { tools: [], nextCursor: null };
  }
  return extractToolsFromJsonRpcMessage(lastPayload);
}

async function parseMcpToolsListResponse(res: Response): Promise<{
  tools: ComposioMcpTool[];
  nextCursor: string | null;
}> {
  const contentType = res.headers.get("content-type") ?? "";
  const text = await res.text();
  if (contentType.includes("text/event-stream")) {
    const fromSse = parseSseJsonRpcTools(text);
    if (fromSse.tools.length > 0 || fromSse.nextCursor) {
      return fromSse;
    }
  }
  try {
    return extractToolsFromJsonRpcMessage(JSON.parse(text) as unknown);
  } catch {
    return parseSseJsonRpcTools(text);
  }
}

/**
 * Lists all tools exposed by Composio's MCP bridge (JSON-RPC `tools/list`).
 *
 * The Dench Cloud gateway exposed a single `/v1/composio/mcp` endpoint that
 * proxied to Composio's MCP. Composio itself has no equivalent single URL —
 * each MCP server has its own URL returned by `/api/v3.1/mcp/servers`.
 *
 * For Phase 1 (UI-only) we don't need this — the integrations UI does fine
 * without the MCP health check. The agent-side switch (phase 2) will create
 * a Composio MCP server per workspace and use its `mcp_url`. Until then we
 * return an empty list so the `/api/composio/status` route still answers.
 */
export async function fetchComposioMcpToolsList(
  _gatewayUrl: string,
  _apiKey: string,
  _options?: {
    connectedToolkits?: string[];
    preferredToolNames?: string[];
    connectedAccountId?: string;
  },
): Promise<ComposioMcpTool[]> {
  return [];
}

// Legacy implementation kept for reference; remove once phase 2 lands.
async function _legacyFetchComposioMcpToolsList(
  gatewayUrl: string,
  apiKey: string,
  options?: {
    connectedToolkits?: string[];
    preferredToolNames?: string[];
    connectedAccountId?: string;
  },
): Promise<ComposioMcpTool[]> {
  const url = `${gatewayUrl.replace(/\/$/, "")}/v1/composio/mcp`;
  const connectedToolkits = options?.connectedToolkits?.filter((slug) => slug.trim().length > 0) ?? [];
  const preferredToolNames = options?.preferredToolNames?.filter((name) => name.trim().length > 0) ?? [];
  const connectedAccountId = options?.connectedAccountId?.trim() || undefined;
  const seen = new Set<string>();
  const out: ComposioMcpTool[] = [];
  let cursor: string | null = null;

  while (true) {
    const requestUrl = new URL(url);
    if (connectedAccountId) {
      requestUrl.searchParams.set("connected_account_id", connectedAccountId);
    }
    const res = await fetch(requestUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        // Forward-compatible hint payload for the external gateway. The current
        // MCP bridge may ignore these fields; a filtered gateway implementation
        // can use them to prioritize connected-app tools without changing the
        // client contract.
        params: {
          ...(connectedToolkits.length > 0 ? { connected_toolkits: connectedToolkits } : {}),
          ...(preferredToolNames.length > 0 ? { preferred_tool_names: preferredToolNames } : {}),
          ...(cursor ? { cursor } : {}),
        },
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `MCP tools/list failed (HTTP ${res.status})${detail ? `: ${detail.slice(0, 300)}` : ""}`,
      );
    }
    const parsed = await parseMcpToolsListResponse(res);
    for (const tool of parsed.tools) {
      if (seen.has(tool.name)) {
        continue;
      }
      seen.add(tool.name);
      out.push(tool);
    }
    if (!parsed.nextCursor || parsed.nextCursor === cursor) {
      return out;
    }
    cursor = parsed.nextCursor;
  }
}
