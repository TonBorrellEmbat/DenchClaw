/**
 * Boot-time cleanup for the previous Composio integration.
 *
 * AlphaDench used to provision Composio MCP servers for HubSpot and Gong at
 * Next.js boot and register them in openclaw.json under `mcp.servers.<slug>`.
 * Those entries are obsolete now — HubSpot and Gong are first-class OpenClaw
 * plugins (extensions/hubspot, extensions/gong) that talk to the provider
 * APIs directly. If old mcp.servers entries linger, OpenClaw still tries to
 * dial the (now-deleted) Composio MCP servers on every boot and floods the
 * gateway log with connection errors.
 *
 * `stripComposioMcpEntries` removes the entries idempotently. It runs from
 * `instrumentation.ts` on every server start, so a single round-trip through
 * the deploy is enough to clean the persistent disk.
 *
 * The whole file (and the /api/composio-direct/status debug route) can be
 * deleted once we're confident no stale entries exist anywhere — kept here
 * to make rollback / re-removal trivial.
 */

const COMPOSIO_SLUGS = new Set([
  "hubspot",
  "gong",
  "composio", // legacy aggregate MCP from earlier denchclaw versions
]);

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function isComposioComposioMcp(url: unknown): boolean {
  if (typeof url !== "string") {
    return false;
  }
  return url.includes("backend.composio.dev");
}

export function stripComposioMcpEntries(): {
  removed: string[];
  configPath: string | null;
} {
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const { resolveOpenClawStateDir } = require("@/lib/workspace") as {
    resolveOpenClawStateDir: () => string;
  };

  let configPath: string;
  try {
    configPath = path.join(resolveOpenClawStateDir(), "openclaw.json");
  } catch {
    return { removed: [], configPath: null };
  }

  if (!fs.existsSync(configPath)) {
    return { removed: [], configPath };
  }

  let config: UnknownRecord;
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf-8")) as UnknownRecord;
  } catch {
    return { removed: [], configPath };
  }

  const mcp = asRecord(config.mcp);
  const servers = mcp ? asRecord(mcp.servers) : null;
  if (!servers) {
    return { removed: [], configPath };
  }

  const removed: string[] = [];
  for (const [slug, raw] of Object.entries(servers)) {
    const entry = asRecord(raw);
    const url = entry ? entry.url : null;
    if (COMPOSIO_SLUGS.has(slug) || isComposioComposioMcp(url)) {
      delete servers[slug];
      removed.push(slug);
    }
  }

  if (removed.length === 0) {
    return { removed: [], configPath };
  }

  if (mcp) {
    mcp.servers = servers;
    config.mcp = mcp;
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
  process.stdout.write(
    `[composio-cleanup] removed mcp.servers entries: ${removed.join(", ")}\n`,
  );
  return { removed, configPath };
}
