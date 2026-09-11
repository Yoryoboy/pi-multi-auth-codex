import { mkdir, mkdtemp, readFile, writeFile, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import lockfile from "proper-lockfile";
import { AccountStore, StoreCommitUncertainError, type Account, type Store } from "../src/accounts/store.js";

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

async function isolatedPath() {
  const directory = await mkdtemp(join(tmpdir(), "pi-multi-auth-store-"));
  return join(directory, "nested", "accounts.json");
}

function runWorker(path: string, id: string, delay: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", join(process.cwd(), "tests/fixtures/store-worker.mjs"), path, id, String(delay)], { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`worker exited with ${code}`)));
  });
}

describe("AccountStore", () => {
      it("migrates both strict v1 shapes atomically and drops positional state", async () => {
        for (const legacy of [
          { version: 1, accounts: [account("one")] },
          { version: 1, accounts: [account("one")], rotationIndex: 9, lastRotation: 123 },
        ]) {
          const path = await isolatedPath();
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, JSON.stringify(legacy));
          await expect(new AccountStore({ path }).load()).resolves.toEqual(
            legacy.lastRotation === undefined
              ? { version: 2, accounts: [account("one")] }
              : { version: 2, accounts: [account("one")], lastRotation: 123 },
          );
          await expect(readFile(path, "utf8")).resolves.not.toContain("rotationIndex");
        }
      });
  it("initializes an empty versioned store without Pi auth files", async () => {
    const path = await isolatedPath();
    const store = new AccountStore({ path });

    await expect(store.load()).resolves.toEqual({ version: 2, accounts: [] });
    await expect(readFile(path, "utf8")).resolves.toBe('{"version":2,"accounts":[]}\n');
    await expect(stat(join(path, ".."))).resolves.toMatchObject({ mode: 0o40700 });
  });

  it("strictly rejects obsolete cursor fields in v2", async () => {
        const path = await isolatedPath();
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, JSON.stringify({ version: 2, accounts: [], rotationIndex: 0 }));
        await expect(new AccountStore({ path }).load()).rejects.toThrow(/invalid account store/i);
      });

      it("round trips accounts and optional metadata", async () => {
    const path = await isolatedPath();
    const value = { ...account("one"), idToken: "id-one", email: "one@example.test", planType: "plus" };
    const store = new AccountStore({ path });

    await store.mutate((current) => ({ ...current, accounts: [value] }));

    await expect(store.load()).resolves.toEqual({ version: 2, accounts: [value] });
  });

  it("rejects malformed stores and never exposes token values", async () => {
    const path = await isolatedPath();
    const store = new AccountStore({ path });
    await store.mutate((current) => ({ ...current, accounts: [account("valid")] }));
    const malformed = { version: 1, accounts: [] };
    await import("node:fs/promises").then(({ writeFile }) => writeFile(path, JSON.stringify({ ...malformed, accounts: [{ ...account("bad"), usageCount: -1 }] })));

    await expect(store.load()).rejects.toThrow(/invalid account store/i);
    await expect(store.load()).rejects.not.toThrow(/access-bad|refresh-bad/);
  });

  it("corrects file permissions when reopening", async () => {
    const path = await isolatedPath();
    const store = new AccountStore({ path });
    await store.load();
    const fileMode = (await stat(path)).mode & 0o777;
    expect(fileMode).toBe(0o600);
  });

  it("applies mutations atomically", async () => {
    const path = await isolatedPath();
    const store = new AccountStore({ path });
    await store.mutate((current) => ({ ...current, accounts: [account("one")] }));
    await expect(store.mutate(() => { throw new Error("mutation failed"); })).rejects.toThrow("mutation failed");
    await expect(store.load()).resolves.toEqual({ version: 2, accounts: [account("one")] });
  });

  it("serializes concurrent mutations across separate processes", async () => {
    const path = await isolatedPath();
    await new AccountStore({ path }).load();
    await Promise.all([runWorker(path, "one", 40), runWorker(path, "two", 0)]);
    await expect(new AccountStore({ path }).load()).resolves.toMatchObject({ accounts: expect.arrayContaining([account("one"), account("two")]) });
  });

  it("uses proper-lockfile's public lock lifecycle and releases cleanly", async () => {
    const path = await isolatedPath();
    await new AccountStore({ path }).load();
    const options = { realpath: false, lockfilePath: `${path}.lock`, stale: 30_000 };
    const release = await lockfile.lock(path, options);
    await expect(lockfile.check(path, options)).resolves.toBe(true);
    const waitingLoad = new AccountStore({ path }).load();
    await release();
    await expect(waitingLoad).resolves.toEqual({ version: 2, accounts: [] });
    await expect(lockfile.check(path, options)).resolves.toBe(false);
  });

  it("cleans temporary files after callback failure and keeps the prior commit", async () => {
    const path = await isolatedPath();
    const store = new AccountStore({ path });
    await store.mutate((current) => ({ ...current, accounts: [account("before")] }));
    await expect(store.mutate(() => { throw new Error("local callback failed"); })).rejects.toThrow("local callback failed");
    await expect(store.load()).resolves.toMatchObject({ accounts: [account("before")] });
    await expect(readdir(dirname(path))).resolves.not.toContain(expect.stringMatching(/\.tmp$/));
  });

  it("does not expose tokens in commit-uncertain errors", () => {
    const error = new StoreCommitUncertainError();
    expect("cause" in error).toBe(false);
    expect(error.code).toBe("STORE_COMMIT_UNCERTAIN");
    expect(error.message).not.toContain("access-secret");
  });

  it("serializes concurrent mutations across store instances", async () => {
    const path = await isolatedPath();
    const first = new AccountStore({ path });
    const second = new AccountStore({ path });
    await first.load();
    await Promise.all([
      first.mutate(async (current) => { await new Promise((resolve) => setTimeout(resolve, 20)); return { ...current, accounts: [...current.accounts, account("one")] }; }),
      second.mutate((current) => ({ ...current, accounts: [...current.accounts, account("two")] })),
    ]);
    await expect(first.load()).resolves.toMatchObject({ accounts: expect.arrayContaining([account("one"), account("two")]) });
  });
});
