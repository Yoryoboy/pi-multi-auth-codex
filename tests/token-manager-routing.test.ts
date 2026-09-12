import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { QuotaResult } from "../src/accounts/quota.js";
import { AccountStore, type Account } from "../src/accounts/store.js";
import { TokenManager } from "../src/auth/token-manager.js";

const account = (id: string): Account => ({
  alias: id,
  id,
  accessToken: `access-${id}`,
  refreshToken: `refresh-${id}`,
  accountId: `account-${id}`,
  expiresAt: 1_000_000,
  enabled: true,
  usageCount: 0,
  lastUsed: null,
  rateLimitedUntil: null,
  ...(id === "model-limited"
    ? { rateLimitedUntilByModel: { target: 2_000 } }
    : {}),
  authInvalidAt: null,
});

async function seeded() {
  const path = join(
    await mkdtemp(join(tmpdir(), "token-manager-routing-")),
    "accounts.json",
  );
  const store = new AccountStore({ path });
  await store.mutate((current) => ({
    ...current,
    routingStrategy: "most-available",
    accounts: [
      account("excluded"),
      account("model-limited"),
      account("winner"),
      account("fallback"),
    ],
  }));
  return store;
}

const quota = (id: string, remaining: number): QuotaResult => ({
  alias: id,
  status: "ok",
  quota: {
    fiveHour: {
      usedPercent: 100 - remaining,
      remainingPercent: remaining,
      resetAfterSeconds: 1,
    },
    weekly: {
      usedPercent: 100 - remaining,
      remainingPercent: remaining,
      resetAfterSeconds: 1,
    },
  },
});

describe("TokenManager routing", () => {
  it("forwards selector quota resolution, model, exclusions, signal, and clock", async () => {
    const store = await seeded();
    const controller = new AbortController();
    const quotaResolver = vi.fn(
      async (accounts: readonly Account[], signal?: AbortSignal) => {
        expect(accounts.map(({ id }) => id)).toEqual(["winner", "fallback"]);
        expect(signal).toBe(controller.signal);
        return new Map(
          accounts.map(({ id }) => [id, quota(id, id === "winner" ? 90 : 10)]),
        );
      },
    );
    const manager = new TokenManager(store, {
      now: () => 1_000,
      excludeAccountKeys: new Set(["excluded"]),
      quotaResolver,
    });

    await expect(
      manager.prepare(controller.signal, "target"),
    ).resolves.toMatchObject({ accountKey: "winner" });
    expect(quotaResolver).toHaveBeenCalledOnce();
    await expect(store.load()).resolves.toMatchObject({
      lastSelectedAccountId: "winner",
      lastRotation: 1_000,
    });
  });

  it("keeps named-account preparation independent of selection and quota resolution", async () => {
    const store = await seeded();
    const quotaResolver = vi.fn(async () => new Map<string, QuotaResult>());
    const manager = new TokenManager(store, {
      now: () => 1_000,
      quotaResolver,
    });

    await expect(manager.prepareAccount("fallback")).resolves.toMatchObject({
      accountKey: "fallback",
    });
    expect(quotaResolver).not.toHaveBeenCalled();
    expect((await store.load()).lastSelectedAccountId).toBeUndefined();
  });
});
