/**
 * Gong (direct) OpenClaw plugin.
 *
 * Registers a set of read-only Gong tools that talk straight to the customer's
 * Gong API base URL with HTTP Basic auth. Replaces the previous Composio-backed
 * Gong tools — no MCP server, no third-party intermediary; credentials never
 * leave the container.
 *
 * Required env vars:
 *   - GONG_ACCESS_KEY      (Gong API access key)
 *   - GONG_ACCESS_SECRET   (Gong API access secret; treated as the BASIC password)
 *   - GONG_API_BASE_URL    (customer-specific, e.g. https://us-71712.api.gong.io)
 *
 * Auth: Authorization: Basic <base64(access_key:access_secret)>.
 *
 * Tool names match the previous Composio surface so the agent's skills + skill
 * docs continue to work unchanged.
 */

import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk";

export const id = "gong";

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function jsonResult(payload: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
    ],
    details: payload,
  };
}

async function parseResponse(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json();
  }
  return response.text();
}

interface GongCallOptions {
  method?: "GET" | "POST";
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

interface GongClient {
  call: (path: string, options?: GongCallOptions) => Promise<unknown>;
}

function makeClient(baseUrl: string, authHeader: string): GongClient {
  const root = baseUrl.replace(/\/$/, "");
  return {
    async call(path, options = {}) {
      const url = new URL(`${root}${path}`);
      if (options.query) {
        for (const [key, value] of Object.entries(options.query)) {
          if (value === undefined || value === null) {
            continue;
          }
          url.searchParams.set(key, String(value));
        }
      }
      const init: RequestInit = {
        method: options.method ?? "GET",
        headers: {
          Authorization: authHeader,
          Accept: "application/json",
          ...(options.body !== undefined
            ? { "Content-Type": "application/json" }
            : {}),
        },
      };
      if (options.body !== undefined) {
        init.body = JSON.stringify(options.body);
      }
      const response = await fetch(url.toString(), init);
      const parsed = await parseResponse(response).catch(() => null);
      if (!response.ok) {
        return {
          error: `Gong request failed (HTTP ${response.status}).`,
          status: response.status,
          detail: parsed ?? null,
        };
      }
      return parsed;
    },
  };
}

function defineTool(
  api: OpenClawPluginApi,
  name: string,
  description: string,
  parameters: UnknownRecord,
  execute: (params: UnknownRecord) => Promise<unknown>,
): void {
  api.registerTool({
    name,
    label: name,
    description,
    parameters,
    execute: async (_toolCallId: string, params: UnknownRecord) => {
      try {
        const result = await execute(params ?? {});
        return jsonResult(result);
      } catch (err) {
        return jsonResult({
          error: "Unexpected error executing Gong tool.",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    },
  } as AnyAgentTool);
}

const stringArray = {
  type: "array" as const,
  items: { type: "string" as const },
};

// Gong's filter / cursor pattern repeats across many "extensive" endpoints.
const callsFilterSchema = {
  type: "object" as const,
  additionalProperties: true,
  description: "Filter object accepted by Gong /v2/calls/extensive (date range, callIds, workspaceId, ...).",
  properties: {
    fromDateTime: { type: "string", description: "ISO-8601 lower bound (inclusive)." },
    toDateTime: { type: "string", description: "ISO-8601 upper bound (exclusive)." },
    callIds: stringArray,
    workspaceId: { type: "string" },
    primaryUserIds: stringArray,
  },
};

export default function register(api: OpenClawPluginApi): void {
  const rootConfig = asRecord(api.config);
  const pluginEntries = asRecord(asRecord(rootConfig?.plugins)?.entries);
  const pluginConfig = asRecord(asRecord(pluginEntries?.[id])?.config);
  if (pluginConfig?.enabled === false) {
    return;
  }

  const accessKey = process.env.GONG_ACCESS_KEY?.trim();
  const accessSecret = process.env.GONG_ACCESS_SECRET?.trim();
  const baseUrl =
    process.env.GONG_API_BASE_URL?.trim() || "https://api.gong.io";

  if (!accessKey || !accessSecret) {
    api.logger?.info?.(
      "[gong] GONG_ACCESS_KEY/GONG_ACCESS_SECRET not set; tools will not be registered.",
    );
    return;
  }

  const authHeader = `Basic ${Buffer.from(`${accessKey}:${accessSecret}`).toString("base64")}`;
  const client = makeClient(baseUrl, authHeader);

  // ── Calls ────────────────────────────────────────────────────────────────
  defineTool(
    api,
    "GONG_RETRIEVE_CALL_DATA_BY_DATE_RANGE_V2_CALLS",
    "List Gong calls in a date range. Returns lightweight call metadata. Use GONG_RETRIEVE_FILTERED_CALL_DETAILS for richer context.",
    {
      type: "object",
      additionalProperties: false,
      properties: {
        fromDateTime: {
          type: "string",
          description: "ISO-8601 lower bound (inclusive). Required.",
        },
        toDateTime: {
          type: "string",
          description: "ISO-8601 upper bound (exclusive). Defaults to now if omitted.",
        },
        cursor: { type: "string", description: "Pagination cursor from a previous response." },
        workspaceId: { type: "string" },
      },
      required: ["fromDateTime"],
    },
    (params) =>
      client.call("/v2/calls", {
        query: {
          fromDateTime: String(params.fromDateTime),
          toDateTime:
            typeof params.toDateTime === "string" ? params.toDateTime : undefined,
          cursor: typeof params.cursor === "string" ? params.cursor : undefined,
          workspaceId:
            typeof params.workspaceId === "string" ? params.workspaceId : undefined,
        },
      }),
  );

  defineTool(
    api,
    "GONG_RETRIEVE_FILTERED_CALL_DETAILS",
    "Search/filter Gong calls with richer detail (participants, content, scorecards). POST to /v2/calls/extensive.",
    {
      type: "object",
      additionalProperties: false,
      properties: {
        filter: callsFilterSchema,
        contentSelector: {
          type: "object",
          additionalProperties: true,
          description: "Which sub-objects to include (e.g. {exposedFields: {parties: true, content: {trackers: true}}}).",
        },
        cursor: { type: "string" },
      },
      required: ["filter"],
    },
    (params) =>
      client.call("/v2/calls/extensive", {
        method: "POST",
        body: {
          filter: params.filter,
          contentSelector: params.contentSelector,
          cursor: typeof params.cursor === "string" ? params.cursor : undefined,
        },
      }),
  );

  defineTool(
    api,
    "GONG_GET_CALL_BY_ID",
    "Fetch a single Gong call's metadata by id. For full content use GONG_RETRIEVE_FILTERED_CALL_DETAILS with `filter.callIds = [id]`.",
    {
      type: "object",
      additionalProperties: false,
      properties: { callId: { type: "string" } },
      required: ["callId"],
    },
    (params) =>
      client.call(`/v2/calls/${encodeURIComponent(String(params.callId))}`),
  );

  defineTool(
    api,
    "GONG_GET_CALL_TRANSCRIPT",
    "Fetch transcripts for one or more Gong calls. POST to /v2/calls/transcript with a filter (callIds and/or date range).",
    {
      type: "object",
      additionalProperties: false,
      properties: {
        filter: {
          type: "object",
          additionalProperties: true,
          properties: {
            callIds: stringArray,
            fromDateTime: { type: "string" },
            toDateTime: { type: "string" },
            workspaceId: { type: "string" },
          },
        },
        cursor: { type: "string" },
      },
      required: ["filter"],
    },
    (params) =>
      client.call("/v2/calls/transcript", {
        method: "POST",
        body: {
          filter: params.filter,
          cursor: typeof params.cursor === "string" ? params.cursor : undefined,
        },
      }),
  );

  // ── Users ────────────────────────────────────────────────────────────────
  defineTool(
    api,
    "GONG_LIST_ALL_USERS_V2_USERS",
    "List all Gong users (paginated).",
    {
      type: "object",
      additionalProperties: false,
      properties: {
        cursor: { type: "string" },
        includeAvatars: { type: "boolean" },
      },
    },
    (params) =>
      client.call("/v2/users", {
        query: {
          cursor: typeof params.cursor === "string" ? params.cursor : undefined,
          includeAvatars:
            typeof params.includeAvatars === "boolean"
              ? params.includeAvatars
              : undefined,
        },
      }),
  );

  defineTool(
    api,
    "GONG_LIST_USERS_BY_FILTER_V2_USERS_EXTENSIVE",
    "List Gong users with detailed filter + projection options. POST to /v2/users/extensive.",
    {
      type: "object",
      additionalProperties: true,
      properties: {
        filter: {
          type: "object",
          additionalProperties: true,
          properties: {
            userIds: stringArray,
            createdFromDateTime: { type: "string" },
            createdToDateTime: { type: "string" },
            includeAvatars: { type: "boolean" },
          },
        },
        cursor: { type: "string" },
      },
    },
    (params) =>
      client.call("/v2/users/extensive", {
        method: "POST",
        body: {
          filter: asRecord(params.filter) ?? {},
          cursor: typeof params.cursor === "string" ? params.cursor : undefined,
        },
      }),
  );

  defineTool(
    api,
    "GONG_GET_USER_BY_ID",
    "Fetch a single Gong user by id.",
    {
      type: "object",
      additionalProperties: false,
      properties: { userId: { type: "string" } },
      required: ["userId"],
    },
    (params) =>
      client.call(`/v2/users/${encodeURIComponent(String(params.userId))}`),
  );

  // ── Workspaces ───────────────────────────────────────────────────────────
  defineTool(
    api,
    "GONG_LIST_ALL_COMPANY_WORKSPACES_V2_WORKSPACES",
    "List all Gong workspaces visible to the API user.",
    { type: "object", additionalProperties: false, properties: {} },
    () => client.call("/v2/workspaces"),
  );

  // ── Stats ────────────────────────────────────────────────────────────────
  defineTool(
    api,
    "GONG_GET_INTERACTION_STATISTICS",
    "Fetch interaction trend statistics for users (calls-with-whisper, etc). POST to /v2/stats/interaction.",
    {
      type: "object",
      additionalProperties: true,
      properties: {
        filter: {
          type: "object",
          additionalProperties: true,
          properties: {
            fromDateTime: { type: "string" },
            toDateTime: { type: "string" },
            userIds: stringArray,
          },
        },
      },
      required: ["filter"],
    },
    (params) =>
      client.call("/v2/stats/interaction", {
        method: "POST",
        body: { filter: params.filter },
      }),
  );

  defineTool(
    api,
    "GONG_AGGREGATE_ACTIVITY_BY_PERIOD_VIA_API",
    "Aggregated user activity per time period across a date range. POST to /v2/stats/activity/aggregate-by-period.",
    {
      type: "object",
      additionalProperties: true,
      properties: {
        filter: {
          type: "object",
          additionalProperties: true,
          properties: {
            fromDateTime: { type: "string" },
            toDateTime: { type: "string" },
            userIds: stringArray,
          },
        },
      },
      required: ["filter"],
    },
    (params) =>
      client.call("/v2/stats/activity/aggregate-by-period", {
        method: "POST",
        body: { filter: params.filter },
      }),
  );

  defineTool(
    api,
    "GONG_AGGREGATE_USER_ACTIVITY_STATISTICS",
    "Aggregate user activity across a date range (single bucket per user). POST to /v2/stats/activity/aggregate.",
    {
      type: "object",
      additionalProperties: true,
      properties: {
        filter: {
          type: "object",
          additionalProperties: true,
          properties: {
            fromDateTime: { type: "string" },
            toDateTime: { type: "string" },
            userIds: stringArray,
          },
        },
      },
      required: ["filter"],
    },
    (params) =>
      client.call("/v2/stats/activity/aggregate", {
        method: "POST",
        body: { filter: params.filter },
      }),
  );

  defineTool(
    api,
    "GONG_POST_DAY_BY_DAY_ACTIVITY_STATS",
    "Day-by-day user activity stats over a range. POST to /v2/stats/activity/day-by-day.",
    {
      type: "object",
      additionalProperties: true,
      properties: {
        filter: {
          type: "object",
          additionalProperties: true,
          properties: {
            fromDateTime: { type: "string" },
            toDateTime: { type: "string" },
            userIds: stringArray,
          },
        },
      },
      required: ["filter"],
    },
    (params) =>
      client.call("/v2/stats/activity/day-by-day", {
        method: "POST",
        body: { filter: params.filter },
      }),
  );

  // ── Scorecards + call outcomes ──────────────────────────────────────────
  defineTool(
    api,
    "GONG_LIST_SCORECARDS",
    "List scorecards in the Gong workspace.",
    {
      type: "object",
      additionalProperties: false,
      properties: { workspaceId: { type: "string" } },
    },
    (params) =>
      client.call("/v2/settings/scorecards", {
        query: {
          workspaceId:
            typeof params.workspaceId === "string" ? params.workspaceId : undefined,
        },
      }),
  );

  defineTool(
    api,
    "GONG_LIST_CALL_OUTCOMES",
    "List available call outcomes configured in Gong.",
    { type: "object", additionalProperties: false, properties: {} },
    () => client.call("/v2/settings/call-outcomes"),
  );

  // ── Library ──────────────────────────────────────────────────────────────
  defineTool(
    api,
    "GONG_LIST_FOLDER_CALLS",
    "Given a Gong library folder id, list the calls inside it.",
    {
      type: "object",
      additionalProperties: false,
      properties: {
        folderId: { type: "string" },
        cursor: { type: "string" },
      },
      required: ["folderId"],
    },
    (params) =>
      client.call("/v2/library/folder-content", {
        query: {
          folderId: String(params.folderId),
          cursor: typeof params.cursor === "string" ? params.cursor : undefined,
        },
      }),
  );

  defineTool(
    api,
    "GONG_RETRIEVE_LIBRARY_FOLDERS_V2_LIBRARY_FOLDERS",
    "List Gong library folders (top-level and nested).",
    { type: "object", additionalProperties: false, properties: {} },
    () => client.call("/v2/library/folders"),
  );

  api.logger?.info?.("[gong] 16 read-only tools registered.");
}
