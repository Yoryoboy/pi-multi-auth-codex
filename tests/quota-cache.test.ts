import { describe, expect, it } from "vitest";
import {
  QUOTA_CACHE_TTL_MS,
  QuotaCache,
  type QuotaResult,
} from "../src/accounts/quota.js";

const successful: QuotaResult = {
  alias: "work",
  status: "ok",
  quota: {
    fiveHour: { usedPercent: 20, remainingPercent: 80, resetAfterSeconds: 60 },
    weekly: { usedPercent: 40, remainingPercent: 60, resetAfterSeconds: 120 },
  },
};

describe("QuotaCache", () => {
  it("returns account-keyed completed results while they are fresh", () => {
    const cache = new QuotaCache();
    cache.set("work-key", successful, 1_000);

    expect(QUOTA_CACHE_TTL_MS).toBe(120_000);
    expect(cache.get("work-key", 1_000)).toEqual(successful);
    expect(cache.get("other-key", 1_000)).toBeUndefined();
    expect(cache.get("work-key", 1_000 + QUOTA_CACHE_TTL_MS - 1)).toEqual(
      successful,
    );
  });

  it("treats the TTL boundary, older entries, and future timestamps as stale", () => {
    const cache = new QuotaCache();
    cache.set("work-key", successful, 1_000);
    expect(cache.get("work-key", 1_000 + QUOTA_CACHE_TTL_MS)).toBeUndefined();

    cache.set("future-key", successful, 2_001);
    expect(cache.get("future-key", 2_000)).toBeUndefined();
  });

  it("retains failed completed results and supports invalidation", () => {
    const cache = new QuotaCache();
    const failed: QuotaResult = { alias: "work", status: "failed" };
    cache.set("work-key", failed, 1_000);
    cache.set("other-key", successful, 1_000);

    expect(cache.get("work-key", 1_001)).toEqual(failed);
    cache.delete("work-key");
    expect(cache.get("work-key", 1_001)).toBeUndefined();
    expect(cache.get("other-key", 1_001)).toEqual(successful);

    cache.clear();
    expect(cache.get("other-key", 1_001)).toBeUndefined();
  });
});
