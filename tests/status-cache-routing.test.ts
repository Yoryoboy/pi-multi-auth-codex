import { describe, expect, it, vi } from "vitest";
import extension from "../src/index.js";

const account = {
  alias: "work",
  id: "work-id",
  accountId: "provider-id",
  accessToken: "access",
  refreshToken: "refresh",
  expiresAt: 9_999_999_999_999,
  enabled: true,
  usageCount: 0,
  lastUsed: null,
  rateLimitedUntil: null,
  authInvalidAt: null,
};

function harness() {
  const events: Record<string, (...args: any[]) => Promise<void>> = {};
  const pi = {
    registerProvider: vi.fn(),
    registerCommand: vi.fn(),
    on: vi.fn((name: string, listener: (...args: any[]) => Promise<void>) => {
      events[name] = listener;
    }),
  } as any;
  const ctx = {
    hasUI: true,
    ui: {
      setStatus: vi.fn(),
      theme: { fg: (_token: string, value: string) => value },
    },
  } as any;
  return { pi, events, ctx };
}

describe("status quota cache routing", () => {
  it("caches completed failures with QuotaCache TTL and the injected clock", async () => {
    let now = 1_000;
    let finish!: (response: Response) => void;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const store = {
      load: vi
        .fn()
        .mockResolvedValue({
          accounts: [account],
          lastSelectedAccountId: account.id,
        }),
    };
    const h = harness();
    extension(h.pi, { createStore: () => store as any, fetch, now: () => now });

    const started = h.events.session_start({}, h.ctx);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    now = 50_000;
    finish(new Response("{}", { status: 500 }));
    await started;

    now = 169_999;
    await h.events.turn_end({}, h.ctx);
    expect(fetch).toHaveBeenCalledOnce();
    now = 170_000;
    const expired = h.events.turn_end({}, h.ctx);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    finish(new Response("{}", { status: 500 }));
    await expired;
  });
});
