import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AccountStore, type Account } from "../src/accounts/store.js";
import { reauthenticateAccount } from "../src/accounts/manage.js";

function jwt(claims: object) {
  const part = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  return `${part}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${part}`;
}

const account = (overrides: Partial<Account> = {}): Account => ({
  alias: "one", id: "one", accessToken: "old-access", refreshToken: "old-refresh", accountId: "acct-one",
  expiresAt: 1_700_000_000_000, enabled: true, usageCount: 0, lastUsed: null, rateLimitedUntil: null,
  authInvalidAt: null, rateLimitedUntilByModel: { "gpt-5.4": 2_000 }, ...overrides,
});

describe("account management", () => {
  it("clears model-specific cooldowns during reauthentication", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "pi-multi-auth-manage-")), "accounts.json");
    const store = new AccountStore({ path });
    await store.mutate(current => ({ ...current, accounts: [account()] }));
    const tokens = { access_token: jwt({ account_id: "acct-one", exp: 2_000_000_000 }), refresh_token: "new-refresh" };
    await reauthenticateAccount(store, "one", tokens, 1_700_000_000_000, {
      accessToken: "old-access", refreshToken: "old-refresh", accountId: "acct-one",
    });
    await expect(store.load()).resolves.toMatchObject({ accounts: [{ accessToken: tokens.access_token, rateLimitedUntil: null }] });
    expect((await store.load()).accounts[0].rateLimitedUntilByModel).toBeUndefined();
  });
});
