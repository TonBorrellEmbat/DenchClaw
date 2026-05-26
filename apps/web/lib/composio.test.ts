import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  disconnectComposioApp,
  fetchComposioMcpToolsList,
  resolveComposioApiKey,
  resolveComposioEligibility,
  resolveComposioGatewayUrl,
} = await import("./composio");

describe("composio config resolution", () => {
  beforeEach(() => {
    delete process.env.COMPOSIO_BASE_URL;
    delete process.env.COMPOSIO_API_KEY;
    delete process.env.DENCH_GATEWAY_URL;
    delete process.env.DENCH_CLOUD_API_KEY;
    delete process.env.DENCH_API_KEY;
  });

  afterEach(() => {
    delete process.env.COMPOSIO_BASE_URL;
    delete process.env.COMPOSIO_API_KEY;
    delete process.env.DENCH_GATEWAY_URL;
    delete process.env.DENCH_CLOUD_API_KEY;
    delete process.env.DENCH_API_KEY;
    vi.restoreAllMocks();
  });

  it("defaults the API base URL to Composio's production host", () => {
    expect(resolveComposioGatewayUrl()).toBe("https://backend.composio.dev");
  });

  it("lets COMPOSIO_BASE_URL override the default base", () => {
    process.env.COMPOSIO_BASE_URL = "https://staging-backend.composio.dev";
    expect(resolveComposioGatewayUrl()).toBe("https://staging-backend.composio.dev");
  });

  it("still honours DENCH_GATEWAY_URL for callers who only have the old env var configured", () => {
    process.env.DENCH_GATEWAY_URL = "https://legacy.example.com";
    expect(resolveComposioGatewayUrl()).toBe("https://legacy.example.com");
  });

  it("reads COMPOSIO_API_KEY when set", () => {
    process.env.COMPOSIO_API_KEY = "co_test_key";
    expect(resolveComposioApiKey()).toBe("co_test_key");
  });

  it("falls back to DENCH_CLOUD_API_KEY for the legacy env var name", () => {
    process.env.DENCH_CLOUD_API_KEY = "dc_legacy_key";
    expect(resolveComposioApiKey()).toBe("dc_legacy_key");
  });

  it("returns ineligible when no API key is configured", () => {
    const result = resolveComposioEligibility();
    expect(result.eligible).toBe(false);
    expect(result.lockReason).toBe("missing_dench_key");
  });

  it("returns eligible whenever a Composio API key is configured", () => {
    process.env.COMPOSIO_API_KEY = "co_test_key";
    expect(resolveComposioEligibility()).toEqual({
      eligible: true,
      lockReason: null,
      lockBadge: null,
    });
  });

  it("fetchComposioMcpToolsList is stubbed in phase 1 — returns [] without calling fetch", async () => {
    // Phase 1 ships the integrations UI only. The agent-side MCP swap (phase
    // 2) will re-implement this against Composio's `/api/v3.1/mcp/servers`
    // and the per-server `mcp_url`. Until then we degrade the status route
    // gracefully instead of pretending the Dench gateway is still there.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 }),
    );
    const tools = await fetchComposioMcpToolsList(
      "https://backend.composio.dev",
      "co_test_key",
      { connectedToolkits: ["gmail"], preferredToolNames: ["GMAIL_FETCH_EMAILS"] },
    );
    expect(tools).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

/**
 * `disconnectComposioApp` contract — pinned because the original code
 * threw on every non-2xx including 404, which surfaced as a confusing
 * "Failed to disconnect (HTTP 404)" toast when the user clicked
 * Disconnect on a stale row whose Composio account had already been
 * revoked upstream (the screenshot bug). The fix: 404 is success
 * with `alreadyGone: true`, anything else still throws.
 */
describe("disconnectComposioApp", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns deleted: true on a successful 200 with JSON body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ deleted: true }), { status: 200 }),
    );
    const result = await disconnectComposioApp("https://gw.example.com", "key", "ca_xxx");
    expect(result).toEqual({ deleted: true });
  });

  it("returns deleted: true with no body when Composio returns an empty 200", async () => {
    // Real REST DELETE responses often have no body; we shouldn't
    // surface "Unexpected end of JSON input" in that case. Note: we
    // can't model 204 here because the WHATWG Response constructor
    // refuses to pair a body with 204 (per spec) — 200 with empty
    // body covers the same code path inside `disconnectComposioApp`.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("", { status: 200 }),
    );
    const result = await disconnectComposioApp("https://gw.example.com", "key", "ca_xxx");
    expect(result).toEqual({ deleted: true });
  });

  it("treats HTTP 404 as already-gone success (the screenshot bug)", async () => {
    // The exact body Composio returns for a connection that no longer
    // exists upstream. Without the 404 special case, this would throw
    // and the user sees "Failed to disconnect (HTTP 404)".
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            message: "Connected account not found",
            type: "invalid_request_error",
            code: "composio_client_error",
          },
        }),
        { status: 404 },
      ),
    );
    const result = await disconnectComposioApp("https://gw.example.com", "key", "ca_dead");
    expect(result).toEqual({ deleted: true, alreadyGone: true });
  });

  it("throws on non-2xx, non-404 errors so transient failures aren't masked", async () => {
    // 502 = real gateway problem. We must throw so the route surfaces
    // a 502 to the client and the modal keeps the row in the list.
    // Treating 5xx as alreadyGone would silently delete entries the
    // user actually wanted to keep.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("bad gateway", { status: 502 }),
    );
    await expect(
      disconnectComposioApp("https://gw.example.com", "key", "ca_xxx"),
    ).rejects.toThrow(/Failed to disconnect.*502/);
  });

  it("hits Composio's connected_accounts endpoint with DELETE + x-api-key auth", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ deleted: true }), { status: 200 }),
    );
    await disconnectComposioApp("https://gw.example.com", "secret_key", "ca_abc");
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://gw.example.com/api/v3.1/connected_accounts/ca_abc");
    expect(init?.method).toBe("DELETE");
    const headers = new Headers(init?.headers as HeadersInit);
    expect(headers.get("x-api-key")).toBe("secret_key");
    expect(headers.get("authorization")).toBeNull();
  });

  it("URL-encodes weird connection ids defensively", async () => {
    // Composio ids are usually slug-safe, but we encode anyway so a
    // future id format with `/` or `%` doesn't punch through to a
    // different path.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ deleted: true }), { status: 200 }),
    );
    await disconnectComposioApp("https://gw.example.com", "k", "ca/with weird?chars");
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe(
      "https://gw.example.com/api/v3.1/connected_accounts/ca%2Fwith%20weird%3Fchars",
    );
  });
});
