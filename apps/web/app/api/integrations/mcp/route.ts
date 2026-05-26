import { listMcpIntegrationStatus } from "@/lib/mcp-integrations";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return Response.json({
    integrations: listMcpIntegrationStatus(),
  });
}
