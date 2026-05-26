import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const {
  invalidateComposioConnectionsCacheMock,
  readOnboardingStateMock,
  writeConnectionMock,
  writeOnboardingStateMock,
} = vi.hoisted(() => ({
  invalidateComposioConnectionsCacheMock: vi.fn(),
  readOnboardingStateMock: vi.fn(),
  writeConnectionMock: vi.fn(),
  writeOnboardingStateMock: vi.fn(),
}));

vi.mock("../connections/cache", () => ({
  invalidateComposioConnectionsCache: invalidateComposioConnectionsCacheMock,
}));

vi.mock("@/lib/integrations", () => ({
  refreshIntegrationsRuntime: vi.fn(),
}));

vi.mock("@/lib/composio", () => ({
  fetchComposioConnections: vi.fn(),
  resolveComposioApiKey: vi.fn(() => "dench_test_key"),
  resolveComposioGatewayUrl: vi.fn(() => "https://gateway.example.com"),
}));

vi.mock("@/lib/denchclaw-state", () => ({
  readOnboardingState: readOnboardingStateMock,
  writeConnection: writeConnectionMock,
  writeOnboardingState: writeOnboardingStateMock,
}));

const { refreshIntegrationsRuntime } = await import("@/lib/integrations");
const { fetchComposioConnections } = await import("@/lib/composio");

const mockedRefreshIntegrationsRuntime = vi.mocked(refreshIntegrationsRuntime);
const mockedFetchComposioConnections = vi.mocked(fetchComposioConnections);

const ORIGINAL_PUBLIC_URL = process.env.DENCHCLAW_PUBLIC_URL;

describe("Composio callback API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.DENCHCLAW_PUBLIC_URL;
    mockedRefreshIntegrationsRuntime.mockResolvedValue({
      attempted: true,
      restarted: true,
      error: null,
      profile: "dench",
    });
    readOnboardingStateMock.mockReturnValue({
      version: 1,
      currentStep: "connect-gmail",
      completedSteps: ["welcome", "identity", "dench-cloud"],
      startedAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
    });
    mockedFetchComposioConnections.mockResolvedValue({
      connections: [
        {
          id: "acct_123",
          toolkit_slug: "twitter",
          toolkit_name: "Twitter",
          status: "ACTIVE",
          created_at: "2026-04-02T00:00:00.000Z",
        },
      ],
    } as never);
  });

  afterEach(() => {
    if (ORIGINAL_PUBLIC_URL === undefined) {
      delete process.env.DENCHCLAW_PUBLIC_URL;
    } else {
      process.env.DENCHCLAW_PUBLIC_URL = ORIGINAL_PUBLIC_URL;
    }
  });

  it("refreshes the runtime after a successful connection", async () => {
    const response = await GET(
      new Request(
        "http://localhost/api/composio/callback?status=success&connected_account_id=acct_123",
      ),
    );

    const html = await response.text();
    expect(response.status).toBe(200);
    expect(invalidateComposioConnectionsCacheMock).toHaveBeenCalledTimes(1);
    expect(mockedRefreshIntegrationsRuntime).toHaveBeenCalledTimes(1);
    expect(html).toContain('"connected_account_id":"acct_123"');
    expect(html).toContain('"connected_toolkit_slug":"x"');
    expect(html).toContain('"connected_toolkit_name":"X"');
  });

  it("persists Gmail callback connections for the sync runner", async () => {
    mockedFetchComposioConnections.mockResolvedValue({
      connections: [
        {
          id: "acct_gmail",
          toolkit_slug: "gmail",
          toolkit_name: "Gmail",
          status: "ACTIVE",
          created_at: "2026-04-02T00:00:00.000Z",
          account_email: "person@example.com",
        },
      ],
    } as never);

    const response = await GET(
      new Request(
        "http://localhost/api/composio/callback?status=success&connected_account_id=acct_gmail",
      ),
    );

    expect(response.status).toBe(200);
    expect(writeConnectionMock).toHaveBeenCalledWith(
      "gmail",
      expect.objectContaining({
        connectionId: "acct_gmail",
        toolkitSlug: "gmail",
        accountEmail: "person@example.com",
      }),
    );
    expect(writeOnboardingStateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        connections: expect.objectContaining({
          gmail: expect.objectContaining({
            connectionId: "acct_gmail",
          }),
        }),
      }),
    );
  });

  it("does not rebuild when the callback is unsuccessful", async () => {
    const response = await GET(
      new Request("http://localhost/api/composio/callback?status=error"),
    );

    expect(response.status).toBe(200);
    expect(invalidateComposioConnectionsCacheMock).not.toHaveBeenCalled();
    expect(mockedRefreshIntegrationsRuntime).not.toHaveBeenCalled();
  });

  it("inlines the request.url origin as targetOrigin in local dev (no proxy, no env)", async () => {
    const response = await GET(
      new Request(
        "http://localhost:3100/api/composio/callback?status=success&connected_account_id=acct_123",
      ),
    );

    const html = await response.text();
    expect(html).toContain('"http://localhost:3100"');
  });

  it("uses DENCHCLAW_PUBLIC_URL as targetOrigin so postMessage matches the parent tab origin", async () => {
    process.env.DENCHCLAW_PUBLIC_URL =
      "https://acme.sandbox.merseoriginals.com";

    const response = await GET(
      new Request(
        "http://localhost:3100/api/composio/callback?status=success&connected_account_id=acct_123",
      ),
    );

    const html = await response.text();
    expect(html).toContain('"https://acme.sandbox.merseoriginals.com"');
    expect(html).not.toContain('"http://localhost:3100"');
  });

  it("prefers DENCHCLAW_PUBLIC_URL over X-Forwarded-Host for the postMessage targetOrigin — AlphaClaw-fronted deploys produce forwarded headers that point at the in-container loopback", async () => {
    process.env.DENCHCLAW_PUBLIC_URL = "https://alphadench.onrender.com";

    const response = await GET(
      new Request(
        "http://localhost:3100/api/composio/callback?status=success&connected_account_id=acct_123",
        {
          headers: {
            "x-forwarded-host": "127.0.0.1:3100",
            "x-forwarded-proto": "http",
          },
        },
      ),
    );

    const html = await response.text();
    expect(html).toContain('"https://alphadench.onrender.com"');
    expect(html).not.toContain('"http://127.0.0.1:3100"');
  });
});
