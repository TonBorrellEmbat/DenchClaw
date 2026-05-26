---
name: dench-integrations
description: Connected-app integration recipes. In this fork the agent uses Composio's hosted MCP servers directly (HUBSPOT_*, GMAIL_*, etc.), not the Dench-gateway dench_* wrappers.
---

# Connected app integrations (Composio MCP, direct)

This deployment is the **Composio-direct fork** of DenchClaw. The legacy
`dench_search_integrations` / `dench_execute_integrations` tools point at
the Dench Cloud gateway, which is not configured here — calling them
returns nothing. **Do not use them.**

Instead, each connected toolkit is exposed to the agent as a native MCP
server (via OpenClaw's `mcp.servers.*` config). The tools appear in your
tool list with their upper-snake slugs (e.g. `HUBSPOT_LIST_DEALS`,
`GMAIL_FETCH_EMAILS`, `SLACK_SEND_MESSAGE`) and you call them directly.

## How to discover which integrations are connected

1. **Look at your available tools.** Any toolkit whose tools appear with
   their `<TOOLKIT>_*` slug is connected and ready.
2. **If a tool you expect isn't there**, the user hasn't connected that
   toolkit yet. Tell them to open the Integrations tab in DenchClaw and
   click Connect for the toolkit. After connection, the agent picks the
   tools up automatically on the next session (or after a gateway
   restart).
3. **Never** call `dench_search_integrations` to "check" — it doesn't
   return useful results in this fork.

## How to call an integration tool

Call it directly by its MCP slug. The `inputSchema` from the tool
listing is authoritative — read field names, types, and required
properties from there.

### HubSpot — find deals closed this week

```
HUBSPOT_SEARCH_DEALS({
  filterGroups: [{
    filters: [
      { propertyName: "hs_is_closed_won", operator: "EQ", value: "true" },
      { propertyName: "closedate", operator: "GTE", value: "<start-of-week>" },
      { propertyName: "closedate", operator: "LTE", value: "<end-of-week>" }
    ]
  }],
  properties: ["dealname", "amount", "closedate", "dealstage"],
  limit: 100
})
```

(The exact filter property names depend on the HubSpot account's deal
pipeline configuration — if `hs_is_closed_won` isn't a property, fall
back to filtering by `dealstage` against the closed-won stage id, which
you can find with `HUBSPOT_GET_PIPELINE_BY_ID`.)

### HubSpot — list contacts

```
HUBSPOT_LIST_CONTACTS({ limit: 25 })
```

### HubSpot — read one contact by id

```
HUBSPOT_READ_CONTACT({ contactId: "<id>" })
```

### Gmail — fetch recent emails

```
GMAIL_FETCH_EMAILS({
  label_ids: ["INBOX"],
  max_results: 10
})
```

### Slack — send a message

```
SLACK_SEND_MESSAGE({
  channel: "C01ABCDEF",
  text: "Hello from DenchClaw!"
})
```

## General rules

- Tool names are **uppercase** with underscores (e.g. `HUBSPOT_LIST_DEALS`).
- Pass **JSON-shaped** arguments as the tool schema requires: arrays are
  arrays, not comma-separated strings.
- Read the returned `inputSchema` before filling arguments. Use exact
  field names and types.
- If a tool isn't in your tool list, **don't** call shell CLIs, `gog`,
  `curl`, or raw REST endpoints to substitute. Stop and tell the user to
  connect that toolkit in the Integrations tab.
- For HubSpot specifically the agent is bounded to read-only CRM scopes
  (contacts, companies, deals, tickets, pipelines, account info). It
  cannot write to HubSpot in this deployment.

## Pagination

When a response includes pagination fields like `paging.next.after`,
`next_cursor`, or `has_more`, keep paginating until you've satisfied the
user's request — but cap at the user's stated limit if any.

## Multi-account handling

The MCP servers in this fork are scoped to one connected account per
toolkit, so you don't need to pass `connected_account_id`. If/when
multi-account support gets added, the tool's `inputSchema` will surface a
`user_id` or `connected_account_id` field — pass the right value from
context.

## Quick recipe table

### HubSpot

| Intent | Tool | Key arguments |
|---|---|---|
| List contacts | `HUBSPOT_LIST_CONTACTS` | `limit` (max 100) |
| Read one contact | `HUBSPOT_READ_CONTACT` | `contactId` |
| Search contacts | `HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA` | `filterGroups`, `properties`, `limit` |
| List companies | `HUBSPOT_LIST_COMPANIES` | `limit` |
| Get company | `HUBSPOT_GET_COMPANY` | `companyId` |
| Search companies | `HUBSPOT_SEARCH_COMPANIES` | `filterGroups`, `properties` |
| List deals | `HUBSPOT_LIST_DEALS` | `limit` |
| Get deal | `HUBSPOT_GET_DEAL` | `dealId` |
| Search deals | `HUBSPOT_SEARCH_DEALS` | `filterGroups`, `properties`, `limit` |
| List tickets | `HUBSPOT_LIST_TICKETS` | `limit` |
| Get pipeline | `HUBSPOT_GET_PIPELINE_BY_ID` | `pipelineId`, `objectType` |
| Account info | `HUBSPOT_GET_ACCOUNT_INFO` | (none) |

### Gmail / Calendar / Drive (when connected)

| Intent | Tool | Key arguments |
|---|---|---|
| List recent mail | `GMAIL_FETCH_EMAILS` | `label_ids: ["INBOX"]`, `max_results` |
| Read one message | `GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID` | `message_id` |
| Send mail | `GMAIL_SEND_EMAIL` | `to`, `subject`, `body` |

## Subagent handoff

When delegating to a subagent, include: the toolkit's MCP tool name (e.g.
`HUBSPOT_SEARCH_DEALS`), the `arguments` object (copy shapes from the
live tool `inputSchema`), and any context-specific filters or limits the
parent agent decided on.
