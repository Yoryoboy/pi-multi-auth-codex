import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createCodexMultiProvider, defaultAccountResolver, defaultAccountStore } from "./provider.js";
import { AccountStore } from "./accounts/store.js";
import { runAccountManager } from "./ui/account-manager.js";
import { createBrowserOpener } from "./ui/browser.js";
import { waitForOAuth } from "./ui/login-wait.js";
import type { BrowserOpener } from "./ui/browser.js";
import type { FetchLike } from "./auth/oauth.js";
import { fetchAllQuotas, formatCompactQuota, type QuotaResult } from "./accounts/quota.js";
export interface ExtensionDependencies { createStore?: () => AccountStore; openBrowser?: BrowserOpener; waitForOAuth?: typeof waitForOAuth; runAccountManager?: typeof runAccountManager; fetch?: FetchLike; }
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
export { fetchAllQuotas, formatCompactQuota, formatQuotaSummary, FIVE_HOUR_SECONDS, WEEK_SECONDS, QUOTA_URL } from "./accounts/quota.js";
export type { PreparedCredentials, TokenManagerOptions } from "./auth/token-manager.js";
export { createBrowserOpener } from "./ui/browser.js";
export { runAccountManager } from "./ui/account-manager.js";
export default function extension(pi: ExtensionAPI, dependencies: ExtensionDependencies = {}) {
  const createStore = dependencies.createStore ?? (() => new AccountStore()); const openBrowser = dependencies.openBrowser ?? createBrowserOpener(); const waitForOAuthImpl = dependencies.waitForOAuth ?? waitForOAuth; const runManager = dependencies.runAccountManager ?? runAccountManager;
  createCodexMultiProvider({ resolveAccount: defaultAccountResolver, store: defaultAccountStore })(pi); const active = new Set<{ controller: AbortController; settled: Promise<unknown> }>(); const cache = new Map<string, { expiresAt: number; result: QuotaResult }>(); const inFlight = new Map<string, { controller: AbortController; promise: Promise<QuotaResult | undefined> }>(); let generation = 0; let runtimeActive = false;
  const updateStatus = async (ctx: ExtensionContext, mine: number) => { if (!ctx.hasUI || !runtimeActive || mine !== generation) return; try { const storeRef = createStore(); const store = await storeRef.load(); if (!runtimeActive || mine !== generation) return; const account = store.accounts.find(item => item.id === store.lastSelectedAccountId); if (!account) { ctx.ui.setStatus("codex-accounts", ctx.ui.theme.fg("dim", "limits unavailable")); return; } const cached = cache.get(account.id); let result = cached && cached.expiresAt > Date.now() ? cached.result : undefined; if (!result) { if (inFlight.has(account.id)) result = await inFlight.get(account.id)!.promise; else { const controller = new AbortController(); const promise = fetchAllQuotas([account], { store: storeRef, fetch: dependencies.fetch, signal: controller.signal }).then(rows => rows[0]); inFlight.set(account.id, { controller, promise }); try { result = await promise; } finally { if (inFlight.get(account.id)?.promise === promise) inFlight.delete(account.id); } } if (result && runtimeActive && mine === generation) cache.set(account.id, { result, expiresAt: Date.now() + 120000 }); } if (!result || !runtimeActive || mine !== generation) return; const maximumUsed = result.status === "ok" && result.quota ? Math.max(result.quota.fiveHour.usedPercent, result.quota.weekly.usedPercent) : 0; const token = result.status === "failed" ? "warning" : maximumUsed > 90 ? "error" : maximumUsed > 75 ? "warning" : "dim"; ctx.ui.setStatus("codex-accounts", ctx.ui.theme.fg(token, formatCompactQuota(result))); } catch { if (runtimeActive && mine === generation) ctx.ui.setStatus("codex-accounts", ctx.ui.theme.fg("warning", "limits unavailable")); } };
  const stop = async () => { const pending = [...inFlight.values()]; for (const request of pending) request.controller.abort(); for (const entry of active) entry.controller.abort(); await Promise.allSettled([...pending.map(request => request.promise), ...[...active].map(entry => entry.settled)]); inFlight.clear(); active.clear(); };
  pi.on("session_start", async (_event, ctx) => { await stop(); runtimeActive = true; const mine = ++generation; await updateStatus(ctx, mine); }); pi.on("turn_end", async (_event, ctx) => { await updateStatus(ctx, generation); }); pi.on("session_shutdown", async (_event, ctx) => { runtimeActive = false; generation++; await stop(); if (ctx.hasUI) ctx.ui.setStatus("codex-accounts", undefined); });
  pi.registerCommand("codex-accounts", { description: "Manage Codex OAuth accounts", handler: async (_args, ctx) => { if (!ctx.hasUI || ctx.mode !== "tui") { ctx.ui.notify("/codex-accounts requires the interactive TUI; no account operation was started.", "error"); return; } const release = (controller: AbortController, operation: Promise<unknown>) => { const entry = { controller, settled: operation.catch(() => undefined) }; active.add(entry); return () => active.delete(entry); }; await runManager({ store: createStore(), ui: { ...ctx.ui, waitForOAuth: (operation, controller) => waitForOAuthImpl(ctx.ui, operation, controller) }, openBrowser, trackOAuth: release, fetch: dependencies.fetch }); await updateStatus(ctx, generation); } });
}
