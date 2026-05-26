"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "../ui/button";

type McpIntegrationStatus = {
  id: "hubspot";
  label: string;
  available: boolean;
  configured: boolean;
  connected: boolean;
  missingEnv: string[];
  connection: {
    connectedAt: string;
    expiresAt?: number;
    scope?: string;
    userEmail?: string;
    hubId?: string;
  } | null;
};

type CallbackPayload = {
  type: "mcp-integration-callback";
  payload: {
    ok: boolean;
    integration: string;
    error?: string;
  };
};

function isCallbackPayload(value: unknown): value is CallbackPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "mcp-integration-callback"
  );
}

const HUBSPOT_DEV_APPS_URL = "https://app.hubspot.com/developer/";

export function McpIntegrationsSection() {
  const [status, setStatus] = useState<McpIntegrationStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/integrations/mcp/hubspot/status");
      if (!res.ok) {
        throw new Error(`Status request failed (${res.status})`);
      }
      setStatus((await res.json()) as McpIntegrationStatus);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load HubSpot status");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      if (!isCallbackPayload(event.data)) return;
      const { ok, error: errMessage } = event.data.payload;
      setConnecting(false);
      if (!ok) {
        setError(errMessage ?? "HubSpot connection failed.");
      } else {
        setError(null);
      }
      void fetchStatus();
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [fetchStatus]);

  const handleConnect = useCallback(async () => {
    setError(null);
    setConnecting(true);
    try {
      const res = await fetch("/api/integrations/mcp/hubspot/connect", { method: "POST" });
      const body = (await res.json()) as { authorize_url?: string; error?: string; guidance?: string };
      if (!res.ok || !body.authorize_url) {
        const detail = body.guidance ? `${body.error ?? "Connect failed"} ${body.guidance}` : body.error ?? `Connect failed (${res.status})`;
        throw new Error(detail);
      }
      const popup = window.open(
        body.authorize_url,
        "hubspot-oauth",
        "popup=yes,width=720,height=820",
      );
      if (!popup) {
        // Popup blocked — fall back to full-page redirect
        window.location.href = body.authorize_url;
      }
    } catch (err) {
      setConnecting(false);
      setError(err instanceof Error ? err.message : "Connect failed");
    }
  }, []);

  const handleDisconnect = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/integrations/mcp/hubspot/disconnect", { method: "POST" });
      if (!res.ok) {
        throw new Error(`Disconnect failed (${res.status})`);
      }
      await fetchStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Disconnect failed");
    }
  }, [fetchStatus]);

  return (
    <section
      className="mb-8 rounded-2xl border"
      style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
    >
      <header className="flex items-start justify-between gap-4 border-b px-5 py-4" style={{ borderColor: "var(--color-border)" }}>
        <div>
          <h2 className="text-base font-medium" style={{ color: "var(--color-text)" }}>
            Direct MCP integrations
          </h2>
          <p className="mt-1 text-xs" style={{ color: "var(--color-text-muted)" }}>
            Connect each provider through its own OAuth — the agent receives only the scopes
            your user has, no umbrella app.
          </p>
        </div>
      </header>

      <div className="divide-y" style={{ borderColor: "var(--color-border)" }}>
        <article className="flex items-start gap-4 px-5 py-4" style={{ borderColor: "var(--color-border)" }}>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium" style={{ color: "var(--color-text)" }}>HubSpot</span>
              {status?.connected && (
                <span
                  className="rounded-full px-2 py-0.5 text-[10px] font-medium"
                  style={{ background: "var(--color-success-bg, #16a34a22)", color: "var(--color-success, #16a34a)" }}
                >
                  Connected
                </span>
              )}
            </div>
            <p className="mt-1 text-xs" style={{ color: "var(--color-text-muted)" }}>
              {loading
                ? "Loading status..."
                : !status?.configured
                  ? `Missing env vars in the deployment: ${status?.missingEnv?.join(", ") ?? "HUBSPOT_OAUTH_CLIENT_ID, HUBSPOT_OAUTH_CLIENT_SECRET"}. Register a HubSpot app at ${HUBSPOT_DEV_APPS_URL} and add the redirect ${window.location.origin}/api/integrations/mcp/hubspot/callback.`
                  : status.connected
                    ? `Connected ${status.connection?.userEmail ? `as ${status.connection.userEmail}` : ""}${status.connection?.hubId ? ` (HubID ${status.connection.hubId})` : ""}.`
                    : "Click Connect to authorize HubSpot via OAuth. You'll see HubSpot's consent screen with the exact scopes."}
            </p>
            {error && (
              <p className="mt-2 text-xs" style={{ color: "var(--color-danger, #b91c1c)" }}>
                {error}
              </p>
            )}
          </div>
          <div className="shrink-0">
            {status?.connected ? (
              <Button type="button" variant="outline" onClick={handleDisconnect}>
                Disconnect
              </Button>
            ) : (
              <Button
                type="button"
                onClick={handleConnect}
                disabled={!status?.configured || connecting}
              >
                {connecting ? "Connecting..." : "Connect"}
              </Button>
            )}
          </div>
        </article>
      </div>
    </section>
  );
}
