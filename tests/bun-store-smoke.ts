import { strict as assert } from "node:assert";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountStore } from "../src/accounts/store.js";

assert.ok("Bun" in globalThis, "smoke must run in Pi's embedded Bun runtime");

const root = await mkdtemp(join(tmpdir(), "pi-multi-auth-bun-store-"));
const path = join(root, "nested", "accounts.json");

try {
  const store = new AccountStore({ path });
  assert.deepEqual(await store.load(), { version: 2, accounts: [] });

  await store.mutate((current) => ({
    ...current,
    accounts: [{
      alias: "bun-marker",
      id: "bun-marker",
      accessToken: "bun-marker",
      refreshToken: "bun-marker",
      accountId: "bun-marker",
      expiresAt: 1_700_000_000_000,
      enabled: true,
      usageCount: 0,
      lastUsed: null,
      rateLimitedUntil: null,
      authInvalidAt: null,
    }],
  }));

  const persisted = await new AccountStore({ path }).load();
  assert.equal(persisted.accounts[0]?.alias, "bun-marker");
  await assert.rejects(stat(`${path}.lock`), { code: "ENOENT" });
  console.log("bun store smoke: passed");
} finally {
  await rm(root, { recursive: true, force: true });
}

export default function bunStoreSmokeExtension(): void {}
