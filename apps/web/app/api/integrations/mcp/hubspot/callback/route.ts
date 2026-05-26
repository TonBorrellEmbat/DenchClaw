import {
  INTEGRATIONS,
  consumeOAuthState,
  exchangeCodeForToken,
  registerMcpServer,
  resolveClientCredentials,
  tokenResponseToRecord,
  writeMcpToken,
} from "@/lib/mcp-integrations";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function serializeForInlineScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function htmlClosingPage(payload: {
  ok: boolean;
  integration: "hubspot";
  error?: string;
}): Response {
  const body = `<!doctype html>
<html>
<head><meta charset="utf-8" /><title>HubSpot connection</title></head>
<body style="font-family: system-ui, sans-serif; padding: 24px;">
  <p>${payload.ok ? "HubSpot connected. You can close this window." : `HubSpot connection failed: ${payload.error ?? "unknown error"}`}</p>
  <script>
    (function () {
      const payload = ${serializeForInlineScript(payload)};
      try {
        if (window.opener && !window.opener.closed) {
          window.opener.postMessage(
            { type: "mcp-integration-callback", payload },
            window.location.origin
          );
        }
      } catch (e) { /* cross-origin opener; ignore */ }
      setTimeout(function () { window.close(); }, 800);
    })();
  </script>
</body>
</html>`;
  return new Response(body, {
    status: payload.ok ? 200 : 400,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description");

  if (error) {
    return htmlClosingPage({
      ok: false,
      integration: "hubspot",
      error: errorDescription ?? error,
    });
  }
  if (!code || !state) {
    return htmlClosingPage({
      ok: false,
      integration: "hubspot",
      error: "Missing code or state in callback URL.",
    });
  }

  const stateEntry = consumeOAuthState(state);
  if (!stateEntry || stateEntry.integration !== "hubspot") {
    return htmlClosingPage({
      ok: false,
      integration: "hubspot",
      error: "OAuth state is missing or expired. Restart the connect flow.",
    });
  }

  const creds = resolveClientCredentials("hubspot");
  if (!creds) {
    return htmlClosingPage({
      ok: false,
      integration: "hubspot",
      error: "HubSpot OAuth client credentials disappeared between connect and callback.",
    });
  }

  try {
    const tokenResponse = await exchangeCodeForToken({
      integration: "hubspot",
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      code,
      codeVerifier: stateEntry.codeVerifier,
      redirectUri: stateEntry.redirectUri,
    });
    const record = tokenResponseToRecord("hubspot", tokenResponse);
    writeMcpToken("hubspot", record);
    registerMcpServer({
      name: "hubspot",
      url: INTEGRATIONS.hubspot.mcpServerUrl,
      accessToken: record.accessToken,
      transport: "streamable-http",
    });
    return htmlClosingPage({ ok: true, integration: "hubspot" });
  } catch (err) {
    return htmlClosingPage({
      ok: false,
      integration: "hubspot",
      error: err instanceof Error ? err.message : "Token exchange failed.",
    });
  }
}
