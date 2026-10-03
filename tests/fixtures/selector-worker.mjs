import { AccountStore } from "../../src/accounts/store.ts";
import { registerHooks } from "node:module";

// Source modules use emitted .js specifiers; this worker executes TypeScript directly.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./store.js" && context.parentURL?.endsWith("/accounts/selector.ts")) {
      return nextResolve("./store.ts", context);
    }
    return nextResolve(specifier, context);
  },
});
const { selectAccount } = await import("../../src/accounts/selector.ts");

const store = new AccountStore({ path: process.argv[2] });
const selected = await selectAccount(store, { now: 1_700_000_000_000 });
process.stdout.write(`${selected.accountId}\n`);
