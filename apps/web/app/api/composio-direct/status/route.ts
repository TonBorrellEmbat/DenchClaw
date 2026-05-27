import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";

import { resolveOpenClawStateDir } from "@/lib/workspace";

export const dynamic = "force-dynamic";

/**
 * Debug endpoint left over from the Composio migration.
 *
 * Now reports two things so we can verify the plugin-based AlphaDench is
 * wired correctly without shelling into the container:
 *   1. Which provider env vars are populated (HubSpot, Gong) — so we can tell
 *      whether the bundled plugins will register their tools at boot.
 *   2. Current mcp.servers in openclaw.json — should be empty/absent for
 *      HubSpot+Gong after stripComposioMcpEntries does its first sweep.
 *
 * Auth-gated by the alphaclaw proxy (setup_token cookie). The file can be
 * removed entirely in the follow-up cleanup release.
 */
export async function GET(): Promise<Response> {
  const stateDir = resolveOpenClawStateDir();
  const openclawPath = path.join(stateDir, "openclaw.json");

  const env = {
    HUBSPOT_PRIVATE_APP_TOKEN: !!process.env.HUBSPOT_PRIVATE_APP_TOKEN,
    GONG_ACCESS_KEY: !!process.env.GONG_ACCESS_KEY,
    GONG_ACCESS_SECRET: !!process.env.GONG_ACCESS_SECRET,
    GONG_API_BASE_URL: process.env.GONG_API_BASE_URL ?? null,
    COMPOSIO_API_KEY: !!process.env.COMPOSIO_API_KEY,
  };

  const out: Record<string, unknown> = { stateDir, env };

  if (existsSync(openclawPath)) {
    try {
      const config = JSON.parse(readFileSync(openclawPath, "utf-8")) as {
        mcp?: { servers?: Record<string, { url?: string }> };
      };
      const servers = config.mcp?.servers ?? {};
      out.mcpServers = Object.fromEntries(
        Object.entries(servers).map(([k, v]) => [k, { url: v.url ?? null }]),
      );
    } catch (err) {
      out.openclaw_error = err instanceof Error ? err.message : String(err);
    }
  } else {
    out.mcpServers = null;
  }

  return NextResponse.json(out);
}
