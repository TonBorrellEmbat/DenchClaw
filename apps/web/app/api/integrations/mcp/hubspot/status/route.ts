import { getMcpIntegrationStatus } from "@/lib/mcp-integrations";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return Response.json(getMcpIntegrationStatus("hubspot"));
}
