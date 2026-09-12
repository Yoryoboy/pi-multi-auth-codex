import { describe, expect, it, vi } from "vitest";
import {
  QUOTA_CACHE_TTL_MS,
  QuotaCache,
  resolveAccountQuotas,
  type QuotaResult,
} from "../src/accounts/quota.js";
import type { Account } from "../src/accounts/store.js";

const account = (alias: string): Account => ({
  alias,
  id: `${alias}-key`,
  accountId: `${alias}-provider`,
  accessToken: `${alias}-access`,
  refreshToken: `${alias}-refresh`,
  expiresAt: 9_999_999_999_999,
  enabled: true,
  usageCount: 0,
  lastUsed: null,
  rateLimitedUntil: null,
  authInvalidAt: null,
});
const ok = (alias: string, usedPercent = 10): QuotaResult => ({
  alias,
  status: "ok",
  quota: {
    fiveHour: {
      usedPercent,
      remainingPercent: 100 - usedPercent,
      resetAfterSeconds: 60,
    },
    weekly: { usedPercent: 20, remainingPercent: 80, resetAfterSeconds: 120 },
  },
});
const response = (usedPercent: number) =>
  new Response(
    JSON.stringify({
      rate_limit: {
        primary_window: { used_percent: usedPercent, reset_after_seconds: 60 },
        secondary_window: { used_percent: 20, reset_after_seconds: 120 },
      },
    }),
  );

describe("account-keyed quota source", () => {
  it("returns fresh cache hits and fetches only misses through prepareAccount", async () => {
    const accounts = [account("cached"), account("miss")];
    const cache = new QuotaCache();
    cache.set("cached-key", ok("cached", 7), 1_000);
    const prepareAccount = vi
      .fn()
      .mockResolvedValue({ accessToken: "token", accountId: "provider" });
    const prepare = vi.fn(() => {
      throw new Error("recursive selection");
    });
    const fetch = vi.fn().mockResolvedValue(response(33));

    const results = await resolveAccountQuotas(accounts, cache, {
      now: () => 1_001,
      fetch,
      tokenManager: { prepareAccount, prepare } as any,
    });

    expect([...results.keys()]).toEqual(["cached-key", "miss-key"]);
    expect(results.get("cached-key")).toEqual(ok("cached", 7));
    expect(results.get("miss-key")?.quota?.fiveHour.usedPercent).toBe(33);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(prepareAccount).toHaveBeenCalledWith(
      "miss-key",
      undefined,
      false,
      accounts[1],
    );
    expect(prepare).not.toHaveBeenCalled();
  });

  it("does not return stale entries and timestamps fetched results on completion", async () => {
    const stale = account("stale");
    const cache = new QuotaCache();
    cache.set(stale.id, ok("stale", 1), 1_000);
    let now = 1_000 + QUOTA_CACHE_TTL_MS;
    const fetch = vi.fn(async () => {
      now = 200_000;
      return response(44);
    });

    const results = await resolveAccountQuotas([stale], cache, {
      now: () => now,
      fetch,
      tokenManager: {
        prepareAccount: vi
          .fn()
          .mockResolvedValue({ accessToken: "token", accountId: "provider" }),
      } as any,
    });

    expect(results.get(stale.id)?.quota?.fiveHour.usedPercent).toBe(44);
    expect(cache.get(stale.id, 200_000 + QUOTA_CACHE_TTL_MS - 1)).toEqual(
      results.get(stale.id),
    );
    expect(cache.get(stale.id, 200_000 + QUOTA_CACHE_TTL_MS)).toBeUndefined();
  });
});
