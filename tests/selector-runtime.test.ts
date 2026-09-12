import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { selectAccount } from "../src/accounts/selector.js";
import { AccountStore, type Account } from "../src/accounts/store.js";
import type { QuotaResult } from "../src/accounts/quota.js";

const account = (id: string): Account => ({
  alias: id,
  id,
  accessToken: `access-${id}`,
  refreshToken: `refresh-${id}`,
  accountId: `account-${id}`,
  expiresAt: 1_700_000_000_000,
  enabled: true,
  usageCount: 0,
  lastUsed: null,
  rateLimitedUntil: null,
  authInvalidAt: null,
});

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

async function seeded(strategy: "round-robin" | "most-available") {
  const path = join(
    await mkdtemp(join(tmpdir(), "selector-runtime-")),
    "accounts.json",
  );
  const store = new AccountStore({ path });
  await store.mutate((current) => ({
    ...current,
    routingStrategy: strategy,
    accounts: [account("a"), account("b"), account("c")],
  }));
  return store;
}

describe("strategy-aware selector runtime", () => {
  it("resolves quota outside mutation and atomically selects the most available account", async () => {
    const store = await seeded("most-available");
    let resolving = false;
    const originalMutate = store.mutate.bind(store);
    store.mutate = vi.fn(async (mutation) => {
      expect(resolving).toBe(false);
      return originalMutate(mutation);
    });
    const quotaResolver = vi.fn(async (accounts: readonly Account[]) => {
      resolving = true;
      expect(accounts.map(({ id }) => id)).toEqual(["a", "b", "c"]);
      resolving = false;
      return new Map(
        accounts.map(({ id }) => [id, quota(id, id === "b" ? 90 : 20)]),
      );
    });

    await expect(
      selectAccount(store, { now: 100, quotaResolver }),
    ).resolves.toMatchObject({ accountKey: "b" });
    await expect(store.load()).resolves.toMatchObject({
      lastSelectedAccountId: "b",
      lastRotation: 100,
      accounts: [
        { usageCount: 0 },
        { usageCount: 1, lastUsed: 100 },
        { usageCount: 0 },
      ],
    });
  });

  it("never resolves quota for effective round-robin", async () => {
    const store = await seeded("round-robin");
    const quotaResolver = vi.fn(async () => new Map<string, QuotaResult>());

    await expect(
      selectAccount(store, { now: 100, quotaResolver }),
    ).resolves.toMatchObject({ accountKey: "a" });
    expect(quotaResolver).not.toHaveBeenCalled();
  });

  it("honors a switch to round-robin while quota is resolving", async () => {
    const store = await seeded("most-available");
    const quotaResolver = vi.fn(async (accounts: readonly Account[]) => {
      await store.mutate((current) => ({
        ...current,
        routingStrategy: "round-robin",
      }));
      return new Map(
        accounts.map(({ id }) => [id, quota(id, id === "c" ? 99 : 1)]),
      );
    });

    await expect(
      selectAccount(store, { now: 100, quotaResolver }),
    ).resolves.toMatchObject({ accountKey: "a" });
    await expect(store.load()).resolves.toMatchObject({
      routingStrategy: "round-robin",
      lastSelectedAccountId: "a",
    });
  });

  it("re-ranks only currently eligible observed accounts", async () => {
    const store = await seeded("most-available");
    const quotaResolver = vi.fn(async (accounts: readonly Account[]) => {
      await store.mutate((current) => ({
        ...current,
        accounts: current.accounts.map((value) =>
          value.id === "b" ? { ...value, enabled: false } : value,
        ),
      }));
      return new Map(
        accounts.map(({ id }) => [
          id,
          quota(id, id === "b" ? 99 : id === "c" ? 80 : 10),
        ]),
      );
    });

    await expect(
      selectAccount(store, { now: 100, quotaResolver }),
    ).resolves.toMatchObject({ accountKey: "c" });
    await expect(store.load()).resolves.toMatchObject({
      lastSelectedAccountId: "c",
      accounts: [
        { usageCount: 0 },
        { enabled: false, usageCount: 0 },
        { usageCount: 1 },
      ],
    });
  });
});
