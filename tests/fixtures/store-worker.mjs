import { AccountStore } from "../../src/accounts/store.ts";

const [path, id, delay = "0"] = process.argv.slice(2);
const account = {
  alias: id, id, accessToken: `access-${id}`, refreshToken: `refresh-${id}`, accountId: `account-${id}`,
  expiresAt: 1700000000000, enabled: true, usageCount: 0, lastUsed: null, rateLimitedUntil: null, authInvalidAt: null,
};
const store = new AccountStore({ path });
await store.mutate(async (current) => {
  await new Promise((resolve) => setTimeout(resolve, Number(delay)));
  return { ...current, accounts: [...current.accounts, account] };
});
