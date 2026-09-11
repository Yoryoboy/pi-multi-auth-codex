import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import lockfile from "proper-lockfile";
import { describe, expect, it } from "vitest";
import { AccountStore, type Account } from "../src/accounts/store.js";
import {
  AUTH_INVALID_COOLDOWN_MS,
  AccountSelectionError,
  createAccountResolver,
  selectAccount,
} from "../src/accounts/selector.js";

const account = (id: string, overrides: Partial<Account> = {}): Account => ({
  alias: id, id, accessToken: `access-${id}`, refreshToken: `refresh-${id}`, accountId: `account-${id}`,
  expiresAt: 1_700_000_000_000, enabled: true, usageCount: 0, lastUsed: null,
  rateLimitedUntil: null, authInvalidAt: null, ...overrides,
});

async function storePath() {
  return join(await mkdtemp(join(tmpdir(), "pi-multi-auth-selector-")), "accounts.json");
}

function runSelector(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", join(process.cwd(), "tests/fixtures/selector-worker.mjs"), path]);
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve(output.trim()) : reject(new Error(`worker exited with ${code}`)));
  });
}

async function seed(path: string, accounts: Account[]) {
  const store = new AccountStore({ path });
  await store.mutate((current) => ({ ...current, accounts }));
  return store;
}

describe("account selector", () => {
      it("advances from the selected identity across changing eligibility", async () => {
        const path = await storePath();
        const store = await seed(path, [account("a"), account("b"), account("c")]);
        expect((await selectAccount(store, { now: 100 })).accountId).toBe("account-a");
        await store.mutate((current) => ({ ...current, accounts: current.accounts.map((value) => value.id === "a" ? { ...value, enabled: false } : value) }));
        expect((await selectAccount(store, { now: 200 })).accountId).toBe("account-b");
      });
  it("alternates deterministically and records the cursor atomically", async () => {
    const path = await storePath();
    const store = await seed(path, [account("one"), account("two")]);
    expect((await selectAccount(store, { now: 100 })).accountId).toBe("account-one");
    expect((await selectAccount(store, { now: 200 })).accountId).toBe("account-two");
    await expect(store.load()).resolves.toMatchObject({ lastSelectedAccountId: "two", lastRotation: 200 });
    expect((await store.load()).accounts.map(({ usageCount, lastUsed }) => [usageCount, lastUsed])).toEqual([[1, 100], [1, 200]]);
  });

  it("skips disabled, rate-limited, and auth-invalid accounts without replaying the cursor", async () => {
        const path = await storePath();
        const store = await seed(path, [account("a"), account("b"), account("c")]);
        expect((await selectAccount(store, { now: 100 })).accountId).toBe("account-a");
        await store.mutate((current) => ({ ...current, accounts: current.accounts.map((value) => value.id === "a" ? { ...value, rateLimitedUntil: 150 } : value) }));
        expect((await selectAccount(store, { now: 200 })).accountId).toBe("account-b");
        await store.mutate((current) => ({ ...current, accounts: current.accounts.map((value) => value.id === "b" ? { ...value, authInvalidAt: 200 } : value) }));
        expect((await selectAccount(store, { now: 300 })).accountId).toBe("account-c");
        await store.mutate((current) => ({ ...current, accounts: current.accounts.filter((value) => value.id !== "c") }));
        expect((await selectAccount(store, { now: 400 })).accountId).toBe("account-a");
      });

      it("does not replay a disabled account when it is re-enabled", async () => {
        const path = await storePath();
        const store = await seed(path, [account("a"), account("b"), account("c")]);
        expect((await selectAccount(store, { now: 100 })).accountId).toBe("account-a");
        await store.mutate((current) => ({ ...current, accounts: current.accounts.map((value) => value.id === "a" ? { ...value, enabled: false } : value) }));
        expect((await selectAccount(store, { now: 200 })).accountId).toBe("account-b");
        await store.mutate((current) => ({ ...current, accounts: current.accounts.map((value) => value.id === "a" ? { ...value, enabled: true } : value) }));
        expect((await selectAccount(store, { now: 300 })).accountId).toBe("account-c");
      });

      it("uses the first account when the cursor account was deleted", async () => {
        const path = await storePath();
        const store = await seed(path, [account("a"), account("b"), account("c")]);
        await selectAccount(store, { now: 100 });
        await store.mutate((current) => ({ ...current, accounts: current.accounts.filter((value) => value.id !== "a") }));
        expect((await selectAccount(store, { now: 200 })).accountId).toBe("account-b");
      });

      it("skips unhealthy accounts and recognizes expired auth cooldowns", async () => {
    const now = AUTH_INVALID_COOLDOWN_MS + 1_000;
    const store = await seed(await storePath(), [
      account("disabled", { enabled: false }),
      account("limited", { rateLimitedUntil: now + 10_000 }),
      account("cooling", { authInvalidAt: now - AUTH_INVALID_COOLDOWN_MS + 1 }),
      account("ready"),
    ]);
    expect((await selectAccount(store, { now })).accountId).toBe("account-ready");
    expect((await selectAccount(store, { now: now + 200 })).accountId).toBe("account-cooling");
  });

  it("aborts deterministically while waiting for the store lock", async () => {
        const path = await storePath();
        const store = await seed(path, [account("one")]);
        const options = { realpath: false, lockfilePath: `${path}.lock`, stale: 30_000 };
        const release = await lockfile.lock(path, options);
        const controller = new AbortController();
        const pending = selectAccount(store, { signal: controller.signal, now: 100 });
        controller.abort();
        await release();
        await expect(pending).rejects.toMatchObject({ code: "ACCOUNT_SELECTION_ABORTED" });
        await expect(store.load()).resolves.toMatchObject({ accounts: [{ usageCount: 0 }] });
      });

      it("returns token-safe errors and honors cancellation", async () => {
    const path = await storePath();
    const store = await seed(path, []);
    await expect(selectAccount(store)).rejects.toMatchObject({ code: "EMPTY_ACCOUNT_STORE" });
    const controller = new AbortController();
    controller.abort();
    await expect(selectAccount(store, { signal: controller.signal })).rejects.toMatchObject({ code: "ACCOUNT_SELECTION_ABORTED" });
    expect((await store.load()).accounts).toEqual([]);
    expect(JSON.stringify(new AccountSelectionError("ALL_ACCOUNTS_UNAVAILABLE", "x"))).not.toContain("x");
  });

  it("serializes concurrent selections across store instances", async () => {
    const path = await storePath();
    await seed(path, [account("one"), account("two")]);
    const selected = await Promise.all([
      selectAccount(new AccountStore({ path }), { now: 1_700_000_000_000 }),
      selectAccount(new AccountStore({ path }), { now: 1_700_000_000_001 }),
    ]);
    expect(selected.map((value) => value.accountId).sort()).toEqual(["account-one", "account-two"]);
    await expect(new AccountStore({ path }).load()).resolves.toMatchObject({
      accounts: expect.arrayContaining([
        expect.objectContaining({ id: "one", usageCount: 1 }),
        expect.objectContaining({ id: "two", usageCount: 1 }),
      ]),
    });
  });

  it("serializes concurrent selections across subprocesses", async () => {
    const path = await storePath();
    await seed(path, [account("one"), account("two")]);
    const selected = await Promise.all([runSelector(path), runSelector(path)]);
    expect(selected.sort()).toEqual(["account-one", "account-two"]);
    await expect(new AccountStore({ path }).load()).resolves.toMatchObject({
      accounts: expect.arrayContaining([
        expect.objectContaining({ id: "one", usageCount: 1 }),
        expect.objectContaining({ id: "two", usageCount: 1 }),
      ]),
    });
  });

  it("uses the later global cooldown when it conflicts with a model cooldown", async () => {
    const store = await seed(await storePath(), [account("a", { rateLimitedUntil: 3_000, rateLimitedUntilByModel: { "gpt-5.4": 2_000 } }), account("b")]);
    expect((await selectAccount(store, { modelId: "gpt-5.4", now: 2_500 })).accountId).toBe("account-b");
  });

  it("does not let one model cooldown block another model", async () => {
    const store = await seed(await storePath(), [account("a", { rateLimitedUntilByModel: { "gpt-5.4": 2_000 } }), account("b")]);
    expect((await selectAccount(store, { modelId: "gpt-5.4", now: 1_000 })).accountId).toBe("account-b");
    expect((await selectAccount(store, { modelId: "gpt-5.5", now: 1_000 })).accountId).toBe("account-a");
  });

  it("forwards request exclusions without mutating the excluded account", async () => {
        const store = await seed(await storePath(), [account("a"), account("b")]);
        const resolver = createAccountResolver(store);
        const selected = await resolver(new AbortController().signal, "gpt-5.6-sol", new Set(["a"]));
        expect(selected).toMatchObject({ accountKey: "b", accountId: "account-b" });
        await expect(store.load()).resolves.toMatchObject({ lastSelectedAccountId: "b", accounts: [{ id: "a", usageCount: 0 }, { id: "b", usageCount: 1 }] });
      });

   it("resolves one request-scoped credential snapshot", async () => {
    const path = await storePath();
    const store = await seed(path, [account("one")]);
    const resolver = createAccountResolver(store);
    const signal = new AbortController().signal;
    expect((await resolver(signal, "gpt-5.6-sol")).accountId).toBe("account-one");
    await expect(store.load()).resolves.toMatchObject({ accounts: [{ usageCount: 1 }] });
  });
});
