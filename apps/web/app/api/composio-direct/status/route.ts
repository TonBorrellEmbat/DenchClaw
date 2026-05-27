import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";

import { resolveOpenClawStateDir } from "@/lib/workspace";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const stateDir = resolveOpenClawStateDir();
  const statusPath = path.join(stateDir, "composio-direct-status.json");
  const openclawPath = path.join(stateDir, "openclaw.json");

  const out: Record<string, unknown> = { stateDir };

  if (existsSync(statusPath)) {
    try {
      out.status = JSON.parse(readFileSync(statusPath, "utf-8"));
    } catch (err) {
      out.status_error = err instanceof Error ? err.message : String(err);
    }
  } else {
    out.status = null;
  }

  if (existsSync(openclawPath)) {
    try {
      const config = JSON.parse(readFileSync(openclawPath, "utf-8")) as {
        mcp?: { servers?: Record<string, { url?: string }> };
      };
      const servers = config.mcp?.servers ?? {};
      out.mcpServers = Object.fromEntries(
        Object.entries(servers).map(([k, v]) => [
          k,
          { url: v.url ?? null },
        ]),
      );
    } catch (err) {
      out.openclaw_error = err instanceof Error ? err.message : String(err);
    }
  } else {
    out.mcpServers = null;
  }

  return NextResponse.json(out);
}
