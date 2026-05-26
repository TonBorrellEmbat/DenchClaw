---
name: composio-apps
description: In this Composio-direct fork, connected apps are exposed as native MCP tools. Use the toolkit slugs directly (HUBSPOT_*, GMAIL_*, etc.) — not the legacy composio_search_tools / dench_* wrappers.
---

# Connected apps in this fork

This deployment is the **Composio-direct fork** of DenchClaw. The
legacy agent-side wrappers (`composio_search_tools`,
`composio_resolve_tool`, `composio_call_tool`, `dench_search_integrations`,
`dench_execute_integrations`) all target the Dench Cloud gateway, which
is not configured here.

**Do not call those wrappers — they will not return useful results.**

Instead, each connected toolkit is exposed natively via OpenClaw's MCP
client (`mcp.servers.<toolkit>` in `openclaw.json`, populated
automatically by the integrations UI after a successful Composio
OAuth). Tools appear in your tool list with their upper-snake slug
(e.g. `HUBSPOT_LIST_DEALS`, `GMAIL_FETCH_EMAILS`). Call them directly.

See `skills/dench-integrations/SKILL.md` for the full recipe table and
calling conventions. The two skills exist for legacy compatibility —
both point at the same direct-MCP path now.
