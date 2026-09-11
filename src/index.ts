import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createCodexMultiProvider, defaultAccountResolver, defaultAccountStore } from "./provider.js";
import { AccountStore } from "./accounts/store.js";
import { accountStatus } from "./accounts/manage.js";
import { runAccountManager } from "./ui/account-manager.js";
import { createBrowserOpener } from "./ui/browser.js";
import { waitForOAuth } from "./ui/login-wait.js";
import type { BrowserOpener } from "./ui/browser.js";

export interface ExtensionDependencies {
  createStore?: () => AccountStore;
  openBrowser?: BrowserOpener;
  waitForOAuth?: typeof waitForOAuth;
  runAccountManager?: typeof runAccountManager;
}

export { createCodexMultiProvider, defaultAccountResolver, defaultAccountStore } from "./provider.js";
export type { AccountResolver, CodexAccount, CodexMultiOptions, ResponsesStreamer } from "./provider.js";
export { AUTH_INVALID_COOLDOWN_MS, AccountSelectionError, createAccountResolver, selectAccount } from "./accounts/selector.js";
export type { AccountSelectionOptions, CodexCredentialSnapshot } from "./accounts/selector.js";
export { AccountStore, createAccountStore, StoreCommitUncertainError } from "./accounts/store.js";
export type { Account, Store } from "./accounts/store.js";
export { accountStatus, maskEmail, renderAccount, reauthenticateAccount, removeAccount, setAccountEnabled, validateAlias, ReauthenticationConflictError } from "./accounts/manage.js";
export type { ReauthenticationExpectation } from "./accounts/manage.js";
export { CODEX_CLIENT_ID, CODEX_REDIRECT_PORTS, OPENAI_ISSUER, OAuthError, createAuthorizationFlow, loginAccount, refreshOAuthToken, tokenIdentity } from "./auth/oauth.js";
export type { AuthorizationFlow, FetchLike, LoginOptions, LoginOperation, OAuthTokens } from "./auth/oauth.js";
export { AccountUpsertError, upsertOAuthAccount } from "./auth/upsert.js";
export { TokenManager, TokenManagerError, createTokenManager } from "./auth/token-manager.js";
export type { PreparedCredentials, TokenManagerOptions } from "./auth/token-manager.js";
export { createBrowserOpener } from "./ui/browser.js";
export { runAccountManager } from "./ui/account-manager.js";

export default function extension(pi: ExtensionAPI, dependencies: ExtensionDependencies = {}) {
      const createStore = dependencies.createStore ?? (() => new AccountStore());
      const openBrowser = dependencies.openBrowser ?? createBrowserOpener();
      const waitForOAuthImpl = dependencies.waitForOAuth ?? waitForOAuth;
      const runManager = dependencies.runAccountManager ?? runAccountManager;
  createCodexMultiProvider({ resolveAccount: defaultAccountResolver, store: defaultAccountStore })(pi);
  const active = new Set<{ controller: AbortController; settled: Promise<unknown> }>();
  let generation = 0;
  let runtimeActive = false;
  const updateStatus = async (ctx: ExtensionContext, mine: number) => {
    if (!ctx.hasUI || !runtimeActive || mine !== generation) return;
    try {
      const store = await createStore().load();
      if (!runtimeActive || mine !== generation) return;
      const available = store.accounts.filter(account => accountStatus(account) === "available").length;
      ctx.ui.setStatus("codex-accounts", ctx.ui.theme.fg("dim", `accounts:${available}/${store.accounts.length}`));
    } catch {
      if (runtimeActive && mine === generation) ctx.ui.setStatus("codex-accounts", ctx.ui.theme.fg("warning", "accounts: unavailable"));
    }
  };
  const stopActive = async () => {
    for (const entry of active) entry.controller.abort();
    await Promise.allSettled([...active].map(entry => entry.settled));
    active.clear();
  };
  pi.on("session_start", async (_event, ctx) => { await stopActive(); runtimeActive = true; const mine = ++generation; await updateStatus(ctx, mine); });
  pi.on("session_shutdown", async (_event, ctx) => {
    runtimeActive = false; generation++;
    await stopActive();
    if (ctx.hasUI) ctx.ui.setStatus("codex-accounts", undefined);
  });
  pi.registerCommand("codex-accounts", {
    description: "Manage Codex OAuth accounts",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI || ctx.mode !== "tui") { ctx.ui.notify("/codex-accounts requires the interactive TUI; no account operation was started.", "error"); return; }
      const release = (controller: AbortController, operation: Promise<unknown>) => {
        const entry = { controller, settled: operation.catch(() => undefined) };
        active.add(entry);
        return () => active.delete(entry);
      };
      await runManager({ store: createStore(), ui: { ...ctx.ui, waitForOAuth: (operation, controller) => waitForOAuthImpl(ctx.ui, operation, controller) }, openBrowser, trackOAuth: release });
      const mine = generation;
      await updateStatus(ctx, mine);
    },
  });
}
