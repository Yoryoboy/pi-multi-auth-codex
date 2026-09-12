import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDefaultAccountResolver } from "../src/accounts/default-resolver.js";
import { AccountStore, type Account } from "../src/accounts/store.js";
import { TokenManager } from "../src/auth/token-manager.js";
import { defaultAccountResolver as exportedResolver } from "../src/index.js";

const account = (id: string): Account => ({
  alias: id,
  id,
  accessToken: `access-${id}`,
  refreshToken: `refresh-${id}`,
  accountId: `provider-${id}`,
  expiresAt: 9_999_999_999_999,
  enabled: true,
  usageCount: 0,
  lastUsed: null,
  rateLimitedUntil: null,
  authInvalidAt: null,
});

const quotaResponse = (usedPercent: number) =>
  new Response(
    JSON.stringify({
      rate_limit: {
        primary_window: { used_percent: usedPercent, reset_after_seconds: 60 },
        secondary_window: {
          used_percent: usedPercent,
          reset_after_seconds: 120,
        },
      },
    }),
  );

describe("default quota-aware routing", () => {
  it("exports an effective resolver and selects the most available account through prepareAccount", async () => {
    expect(exportedResolver).toBeTypeOf("function");
    const path = join(
      await mkdtemp(join(tmpdir(), "default-routing-")),
      "accounts.json",
    );
    const store = new AccountStore({ path });
    await store.mutate((current) => ({
      ...current,
      routingStrategy: "most-available",
      accounts: [account("busy"), account("available"), account("excluded")],
    }));
    const fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const id = (init?.headers as Record<string, string>)[
        "ChatGPT-Account-Id"
      ];
      return quotaResponse(id === "provider-available" ? 10 : 90);
    });
    const prepareAccount = vi.spyOn(TokenManager.prototype, "prepareAccount");
    const resolver = createDefaultAccountResolver(store, { fetch });

    await expect(
      resolver(undefined, "gpt-test", new Set(["excluded"])),
    ).resolves.toMatchObject({ accountKey: "available" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(prepareAccount).toHaveBeenCalledTimes(3);

    await resolver(undefined, "gpt-test", new Set(["excluded"]));
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
