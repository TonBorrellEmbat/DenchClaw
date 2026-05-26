import {
  buildAuthorizeUrl,
  createPkcePair,
  createStateToken,
  rememberOAuthState,
  resolveClientCredentials,
} from "@/lib/mcp-integrations";
import { resolveAppPublicOrigin } from "@/lib/public-origin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  const creds = resolveClientCredentials("hubspot");
  if (!creds) {
    return Response.json(
      {
        error: "HubSpot OAuth client is not configured.",
        guidance:
          "Set HUBSPOT_OAUTH_CLIENT_ID and HUBSPOT_OAUTH_CLIENT_SECRET in the deployment environment.",
      },
      { status: 400 },
    );
  }

  const origin = resolveAppPublicOrigin(request);
  const redirectUri = `${origin}/api/integrations/mcp/hubspot/callback`;
  const { codeVerifier, codeChallenge } = createPkcePair();
  const state = createStateToken();

  rememberOAuthState(state, {
    integration: "hubspot",
    codeVerifier,
    redirectUri,
  });

  const authorizeUrl = buildAuthorizeUrl({
    integration: "hubspot",
    clientId: creds.clientId,
    redirectUri,
    state,
    codeChallenge,
  });

  return Response.json({
    authorize_url: authorizeUrl,
    redirect_uri: redirectUri,
    state,
  });
}
