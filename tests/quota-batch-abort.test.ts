import { describe, expect, it, vi } from "vitest";
import { QuotaCache, resolveAccountQuotas } from "../src/accounts/quota.js";

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

describe("quota batch abort atomicity", () => {
  it("publishes no cache entries when a later account aborts after an ordinary failure", async () => {
    const cache = new QuotaCache();
    const controller = new AbortController();
    let rejectSecond!: (reason: unknown) => void;
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 500 }))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((_resolve, reject) => {
            rejectSecond = reject;
          }),
      )
      .mockResolvedValue(new Response("{}", { status: 500 }));
    const accounts = [account("first"), account("second")];

    const abortedBatch = resolveAccountQuotas(accounts, cache, {
      fetch,
      signal: controller.signal,
      concurrency: 2,
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    controller.abort();
    rejectSecond(new DOMException("aborted", "AbortError"));
    await abortedBatch;

    await resolveAccountQuotas(accounts, cache, { fetch, concurrency: 2 });
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});
