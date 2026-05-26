import { clearMcpToken, unregisterMcpServer } from "@/lib/mcp-integrations";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function disconnect() {
  unregisterMcpServer("hubspot");
  clearMcpToken("hubspot");
  return Response.json({ ok: true });
}

export async function POST() {
  return disconnect();
}

export async function DELETE() {
  return disconnect();
}
