import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { setRoutingStrategy } from "../src/accounts/manage.js";
import {
  AccountStore,
  StoreCommitUncertainError,
  type Account,
  type Store,
} from "../src/accounts/store.js";

const account: Account = {
  alias: "one",
  id: "one",
  accessToken: "access",
  refreshToken: "refresh",
  accountId: "acct-one",
  expiresAt: 1_700_000_000_000,
  enabled: true,
  usageCount: 3,
  lastUsed: 1_600_000_000_000,
  rateLimitedUntil: null,
  authInvalidAt: null,
};

describe("setRoutingStrategy", () => {
  it("persists a changed strategy while preserving all other state", async () => {
    const path = join(
      await mkdtemp(join(tmpdir(), "pi-multi-auth-manage-routing-")),
      "accounts.json",
    );
    const store = new AccountStore({ path });
    const initial: Store = {
      version: 2,
      accounts: [account],
      lastSelectedAccountId: "one",
      lastRotation: 123,
      routingStrategy: "round-robin",
    };
    await store.mutate(() => initial);

    const result = await setRoutingStrategy(store, "most-available");

    expect(result).toEqual({ ...initial, routingStrategy: "most-available" });
    await expect(store.load()).resolves.toEqual(result);
  });

  it("returns the same store reference when the strategy is unchanged", async () => {
    const current: Store = {
      version: 2,
      accounts: [account],
      routingStrategy: "most-available",
    };
    let mutationResult: Store | undefined;
    const store = {
      mutate: async (mutation: (value: Store) => Store | Promise<Store>) => {
        mutationResult = await mutation(current);
        return mutationResult;
      },
    } as AccountStore;

    const result = await setRoutingStrategy(store, "most-available");

    expect(result).toBe(current);
    expect(mutationResult).toBe(current);
  });

  it("reports an uncertain commit using the existing mutation convention", async () => {
    const store = {
      mutate: async () => {
        throw new StoreCommitUncertainError();
      },
    } as unknown as AccountStore;

    await expect(setRoutingStrategy(store, "most-available")).resolves.toEqual({
      uncertain: true,
    });
  });
});
