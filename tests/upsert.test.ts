import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { AccountStore } from "../src/accounts/store.js";
import { AccountUpsertError, upsertOAuthAccount } from "../src/auth/upsert.js";

function jwt(id: string) { const part = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"); return `${part}.${Buffer.from(JSON.stringify({ account_id: id, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.${part}`; }
async function makeStore() { return new AccountStore({ path: join(await mkdtemp(join(tmpdir(), "codex-upsert-")), "accounts.json") }); }

describe("OAuth account upsert", () => {
  it("rejects alias collisions without mutating the store", async () => {
    const store = await makeStore();
    await upsertOAuthAccount(store, "work", { access_token: jwt("one"), refresh_token: "r1" });
    await expect(upsertOAuthAccount(store, "work", { access_token: jwt("two"), refresh_token: "r2" })).rejects.toMatchObject({ code: "ACCOUNT_ALIAS_COLLISION" });
    expect((await store.load()).accounts).toHaveLength(1);
  });
  it("does not enumerate sensitive error details", () => {
    const error = new AccountUpsertError("ACCOUNT_ALIAS_COLLISION", "Account alias is already in use");
    expect(Object.keys(error)).toEqual([]);
    expect(JSON.stringify(error)).toBe("{}");
  });
});
