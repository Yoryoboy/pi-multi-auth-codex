import { describe, expect, it, vi } from "vitest";
import {
  QUOTA_CACHE_TTL_MS,
  QuotaCache,
  resolveAccountQuotas,
} from "../src/accounts/quota.js";

const account = (id: string) => ({
  alias: id,
  id,
  accountId: `provider-${id}`,
  accessToken: `access-${id}`,
  refreshToken: `refresh-${id}`,
  expiresAt: 9_999_999_999_999,
  enabled: true,
  usageCount: 0,
  lastUsed: null,
  rateLimitedUntil: null,
  authInvalidAt: null,
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("quota cache cancellation and freshness", () => {
  it("does not let an aborted status request poison the shared routing cache", async () => {
    const cache = new QuotaCache();
    const controller = new AbortController();
    let rejectStatus!: (reason: unknown) => void;
    const fetch = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((_resolve, reject) => {
            rejectStatus = reject;
          }),
      )
      .mockResolvedValueOnce(new Response("{}", { status: 500 }));

    const status = resolveAccountQuotas([account("work")], cache, {
      fetch,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    controller.abort();
    rejectStatus(new DOMException("aborted", "AbortError"));
    await status;

    await resolveAccountQuotas([account("work")], cache, { fetch });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("starts each account TTL at that account's own completion time", async () => {
    let now = 0;
    const cache = new QuotaCache();
    const finishes = new Map<string, (response: Response) => void>();
    const fetch = vi.fn((_url: string | URL, init?: RequestInit) => {
      const id = String(
        (init?.headers as Record<string, string>)["ChatGPT-Account-Id"],
      ).replace("provider-", "");
      return new Promise<Response>((resolve) => finishes.set(id, resolve));
    });
    const accounts = [account("first"), account("second")];

    const initial = resolveAccountQuotas(accounts, cache, {
      fetch,
      now: () => now,
      concurrency: 2,
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    now = 10;
    finishes.get("first")!(new Response("{}", { status: 500 }));
    await tick();
    now = 20;
    finishes.get("second")!(new Response("{}", { status: 500 }));
    await initial;

    now = 10 + QUOTA_CACHE_TTL_MS;
    const refresh = resolveAccountQuotas(accounts, cache, {
      fetch,
      now: () => now,
      concurrency: 2,
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    expect(
      (fetch.mock.calls[2]![1]?.headers as Record<string, string>)[
        "ChatGPT-Account-Id"
      ],
    ).toBe("provider-first");
    finishes.get("first")!(new Response("{}", { status: 500 }));
    await refresh;
  });
});
