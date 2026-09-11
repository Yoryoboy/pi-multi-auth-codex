import { AccountStore } from "../../src/accounts/store.ts";
import { selectAccount } from "../../src/accounts/selector.ts";

const store = new AccountStore({ path: process.argv[2] });
const selected = await selectAccount(store, { now: 1_700_000_000_000 });
process.stdout.write(`${selected.accountId}\n`);
