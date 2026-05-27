/**
 * HubSpot (direct) OpenClaw plugin.
 *
 * Registers a set of read-only CRM tools that talk straight to api.hubapi.com
 * with a Private App access token. Replaces the previous Composio-backed
 * HubSpot tools — no MCP server, no third-party intermediary; the token never
 * leaves the container.
 *
 * Auth: `Authorization: Bearer ${HUBSPOT_PRIVATE_APP_TOKEN}`.
 *
 * Tool names match what the agent's skills + skill docs already expect
 * (HUBSPOT_LIST_CONTACTS, HUBSPOT_SEARCH_DEALS, ...). That keeps the existing
 * prompt surface unchanged and removes the need to rewrite the skill files.
 */

import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk";

export const id = "hubspot";

const API_BASE = "https://api.hubapi.com";

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

interface HubSpotCallOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

async function hubspotFetch(
  token: string,
  path: string,
  options: HubSpotCallOptions = {},
): Promise<unknown> {
  const url = new URL(`${API_BASE}${path}`);
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
      Authorization: `Bearer ${token}`,
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
      error: `HubSpot request failed (HTTP ${response.status}).`,
      status: response.status,
      detail: parsed ?? null,
    };
  }
  return parsed;
}

const stringArray = {
  type: "array" as const,
  items: { type: "string" as const },
};

const filterSchema = {
  type: "object" as const,
  additionalProperties: false,
  properties: {
    propertyName: { type: "string" as const },
    operator: { type: "string" as const },
    value: {},
    values: { type: "array" as const, items: {} },
    highValue: {},
  },
  required: ["propertyName", "operator"],
};

const filterGroupSchema = {
  type: "object" as const,
  additionalProperties: false,
  properties: {
    filters: { type: "array" as const, items: filterSchema },
  },
  required: ["filters"],
};

const sortSchema = {
  type: "object" as const,
  additionalProperties: false,
  properties: {
    propertyName: { type: "string" as const },
    direction: { type: "string" as const, enum: ["ASCENDING", "DESCENDING"] },
  },
  required: ["propertyName", "direction"],
};

function buildSearchBody(params: UnknownRecord): UnknownRecord {
  const body: UnknownRecord = {};
  if (Array.isArray(params.filterGroups)) body.filterGroups = params.filterGroups;
  if (typeof params.query === "string" && params.query.length > 0) {
    body.query = params.query;
  }
  if (Array.isArray(params.sorts)) body.sorts = params.sorts;
  if (Array.isArray(params.properties)) body.properties = params.properties;
  if (typeof params.limit === "number") body.limit = params.limit;
  if (typeof params.after === "string" && params.after.length > 0) {
    body.after = params.after;
  }
  return body;
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
          error: "Unexpected error executing HubSpot tool.",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    },
  } as AnyAgentTool);
}

const listParameters = (objectLabel: string) => ({
  type: "object" as const,
  additionalProperties: false,
  properties: {
    limit: {
      type: "integer",
      description: `Page size (1-100). Default 10. Use to control how many ${objectLabel} per page.`,
      minimum: 1,
      maximum: 100,
    },
    after: {
      type: "string",
      description: "Pagination cursor returned in `paging.next.after` of the previous response.",
    },
    properties: {
      ...stringArray,
      description: `Optional list of property names to include on each ${objectLabel}.`,
    },
    archived: {
      type: "boolean",
      description: "Whether to include only archived records. Defaults to false.",
    },
  },
});

const readParameters = (objectLabel: string, idProp: string) => ({
  type: "object" as const,
  additionalProperties: false,
  properties: {
    [idProp]: {
      type: "string",
      description: `${objectLabel} record id (or value of idProperty when supplied).`,
    },
    properties: {
      ...stringArray,
      description: "Optional list of property names to fetch on the record.",
    },
    idProperty: {
      type: "string",
      description: "Custom unique-id property to look the record up by (e.g. `email`).",
    },
  },
  required: [idProp],
});

const batchReadParameters = (objectLabel: string) => ({
  type: "object" as const,
  additionalProperties: false,
  properties: {
    inputs: {
      type: "array",
      description: `Array of {id} entries for the ${objectLabel} records to read (max 100).`,
      items: {
        type: "object",
        additionalProperties: false,
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    },
    properties: {
      ...stringArray,
      description: "Optional list of property names to fetch on each record.",
    },
    idProperty: {
      type: "string",
      description: "Custom unique-id property to look records up by.",
    },
  },
  required: ["inputs"],
});

const searchParameters = (objectLabel: string) => ({
  type: "object" as const,
  additionalProperties: false,
  properties: {
    filterGroups: {
      type: "array",
      items: filterGroupSchema,
      description: `Array of filter groups (OR'd together). Each group's filters are AND'd. Use to find ${objectLabel} by property criteria.`,
    },
    query: {
      type: "string",
      description: "Free-text query (alternative to filterGroups, less precise).",
    },
    sorts: {
      type: "array",
      items: sortSchema,
      description: "Sort criteria.",
    },
    properties: {
      ...stringArray,
      description: "Property names to include on results.",
    },
    limit: { type: "integer", minimum: 1, maximum: 200 },
    after: { type: "string", description: "Pagination cursor." },
  },
});

export default function register(api: OpenClawPluginApi): void {
  const rootConfig = asRecord(api.config);
  const pluginEntries = asRecord(asRecord(rootConfig?.plugins)?.entries);
  const pluginConfig = asRecord(asRecord(pluginEntries?.[id])?.config);
  if (pluginConfig?.enabled === false) {
    return;
  }

  const token = process.env.HUBSPOT_PRIVATE_APP_TOKEN?.trim();
  if (!token) {
    api.logger?.info?.(
      "[hubspot] HUBSPOT_PRIVATE_APP_TOKEN not set; tools will not be registered.",
    );
    return;
  }

  // ── Contacts ─────────────────────────────────────────────────────────────
  defineTool(
    api,
    "HUBSPOT_LIST_CONTACTS",
    "List HubSpot contacts (paginated). Use for browsing — for criteria-based lookup prefer HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA.",
    listParameters("contacts"),
    (params) =>
      hubspotFetch(token, "/crm/v3/objects/contacts", {
        query: {
          limit: typeof params.limit === "number" ? params.limit : 10,
          after: typeof params.after === "string" ? params.after : undefined,
          properties: Array.isArray(params.properties)
            ? params.properties.join(",")
            : undefined,
          archived: typeof params.archived === "boolean" ? params.archived : undefined,
        },
      }),
  );

  defineTool(
    api,
    "HUBSPOT_READ_CONTACT",
    "Read a single HubSpot contact by id (or by another unique property when idProperty is supplied).",
    readParameters("contact", "contactId"),
    (params) =>
      hubspotFetch(
        token,
        `/crm/v3/objects/contacts/${encodeURIComponent(String(params.contactId))}`,
        {
          query: {
            properties: Array.isArray(params.properties)
              ? params.properties.join(",")
              : undefined,
            idProperty:
              typeof params.idProperty === "string" ? params.idProperty : undefined,
          },
        },
      ),
  );

  defineTool(
    api,
    "HUBSPOT_READ_CONTACTS",
    "Batch-read up to 100 HubSpot contacts by id in one call.",
    batchReadParameters("contact"),
    (params) =>
      hubspotFetch(token, "/crm/v3/objects/contacts/batch/read", {
        method: "POST",
        body: {
          inputs: params.inputs,
          properties: Array.isArray(params.properties) ? params.properties : undefined,
          idProperty:
            typeof params.idProperty === "string" ? params.idProperty : undefined,
        },
      }),
  );

  defineTool(
    api,
    "HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA",
    "Search HubSpot contacts by property filters. Build filterGroups for precise criteria (e.g. lifecyclestage = customer).",
    searchParameters("contacts"),
    (params) =>
      hubspotFetch(token, "/crm/v3/objects/contacts/search", {
        method: "POST",
        body: buildSearchBody(params),
      }),
  );

  defineTool(
    api,
    "HUBSPOT_LIST_CONTACT_PROPERTIES",
    "List metadata for all HubSpot contact properties (names, types, labels, options).",
    { type: "object", additionalProperties: false, properties: {} },
    () => hubspotFetch(token, "/crm/v3/properties/contacts"),
  );

  // ── Companies ────────────────────────────────────────────────────────────
  defineTool(
    api,
    "HUBSPOT_LIST_COMPANIES",
    "List HubSpot companies (paginated).",
    listParameters("companies"),
    (params) =>
      hubspotFetch(token, "/crm/v3/objects/companies", {
        query: {
          limit: typeof params.limit === "number" ? params.limit : 10,
          after: typeof params.after === "string" ? params.after : undefined,
          properties: Array.isArray(params.properties)
            ? params.properties.join(",")
            : undefined,
          archived: typeof params.archived === "boolean" ? params.archived : undefined,
        },
      }),
  );

  defineTool(
    api,
    "HUBSPOT_GET_COMPANY",
    "Read a single HubSpot company by id (or by another unique property when idProperty is supplied).",
    readParameters("company", "companyId"),
    (params) =>
      hubspotFetch(
        token,
        `/crm/v3/objects/companies/${encodeURIComponent(String(params.companyId))}`,
        {
          query: {
            properties: Array.isArray(params.properties)
              ? params.properties.join(",")
              : undefined,
            idProperty:
              typeof params.idProperty === "string" ? params.idProperty : undefined,
          },
        },
      ),
  );

  defineTool(
    api,
    "HUBSPOT_SEARCH_COMPANIES",
    "Search HubSpot companies by property filters.",
    searchParameters("companies"),
    (params) =>
      hubspotFetch(token, "/crm/v3/objects/companies/search", {
        method: "POST",
        body: buildSearchBody(params),
      }),
  );

  defineTool(
    api,
    "HUBSPOT_BATCH_READ_COMPANIES_BY_PROPERTIES",
    "Batch-read up to 100 HubSpot companies in one call. Supports custom idProperty (e.g. `domain`).",
    batchReadParameters("company"),
    (params) =>
      hubspotFetch(token, "/crm/v3/objects/companies/batch/read", {
        method: "POST",
        body: {
          inputs: params.inputs,
          properties: Array.isArray(params.properties) ? params.properties : undefined,
          idProperty:
            typeof params.idProperty === "string" ? params.idProperty : undefined,
        },
      }),
  );

  // ── Deals ────────────────────────────────────────────────────────────────
  defineTool(
    api,
    "HUBSPOT_LIST_DEALS",
    "List HubSpot deals (paginated).",
    listParameters("deals"),
    (params) =>
      hubspotFetch(token, "/crm/v3/objects/deals", {
        query: {
          limit: typeof params.limit === "number" ? params.limit : 10,
          after: typeof params.after === "string" ? params.after : undefined,
          properties: Array.isArray(params.properties)
            ? params.properties.join(",")
            : undefined,
          archived: typeof params.archived === "boolean" ? params.archived : undefined,
        },
      }),
  );

  defineTool(
    api,
    "HUBSPOT_GET_DEAL",
    "Read a single HubSpot deal by id.",
    readParameters("deal", "dealId"),
    (params) =>
      hubspotFetch(
        token,
        `/crm/v3/objects/deals/${encodeURIComponent(String(params.dealId))}`,
        {
          query: {
            properties: Array.isArray(params.properties)
              ? params.properties.join(",")
              : undefined,
            idProperty:
              typeof params.idProperty === "string" ? params.idProperty : undefined,
          },
        },
      ),
  );

  defineTool(
    api,
    "HUBSPOT_GET_DEALS",
    "Batch-read up to 100 HubSpot deals by id in one call.",
    batchReadParameters("deal"),
    (params) =>
      hubspotFetch(token, "/crm/v3/objects/deals/batch/read", {
        method: "POST",
        body: {
          inputs: params.inputs,
          properties: Array.isArray(params.properties) ? params.properties : undefined,
          idProperty:
            typeof params.idProperty === "string" ? params.idProperty : undefined,
        },
      }),
  );

  defineTool(
    api,
    "HUBSPOT_SEARCH_DEALS",
    "Search HubSpot deals by property filters (e.g. dealstage, closedate).",
    searchParameters("deals"),
    (params) =>
      hubspotFetch(token, "/crm/v3/objects/deals/search", {
        method: "POST",
        body: buildSearchBody(params),
      }),
  );

  // ── Pipelines + account info ────────────────────────────────────────────
  defineTool(
    api,
    "HUBSPOT_GET_PIPELINE_BY_ID",
    "Fetch a HubSpot pipeline by id (default object type: deals).",
    {
      type: "object",
      additionalProperties: false,
      properties: {
        pipelineId: { type: "string", description: "HubSpot pipeline id." },
        objectType: {
          type: "string",
          description: "Object type the pipeline applies to. Defaults to `deals`. Use `tickets`, `0-2` etc. as needed.",
        },
      },
      required: ["pipelineId"],
    },
    (params) => {
      const objectType =
        typeof params.objectType === "string" && params.objectType.length > 0
          ? params.objectType
          : "deals";
      return hubspotFetch(
        token,
        `/crm/v3/pipelines/${encodeURIComponent(objectType)}/${encodeURIComponent(String(params.pipelineId))}`,
      );
    },
  );

  defineTool(
    api,
    "HUBSPOT_GET_ACCOUNT_INFO",
    "Fetch HubSpot account/portal details (portalId, currency, timezone, hub domain).",
    { type: "object", additionalProperties: false, properties: {} },
    () => hubspotFetch(token, "/account-info/v3/details"),
  );

  api.logger?.info?.("[hubspot] 15 read-only tools registered.");
}
