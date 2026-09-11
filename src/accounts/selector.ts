import type { Account, AccountStore, Store } from "./store.js";
export const AUTH_INVALID_COOLDOWN_MS = 5 * 60 * 1_000;
export type AccountSelectionErrorCode = "EMPTY_ACCOUNT_STORE" | "ALL_ACCOUNTS_UNAVAILABLE" | "ACCOUNT_SELECTION_ABORTED";
export class AccountSelectionError extends Error {
  readonly code: AccountSelectionErrorCode;
  constructor(code: AccountSelectionErrorCode, message: string) { super(message); this.code = code; this.name = "AccountSelectionError"; }
}
export interface AccountSelectionOptions { signal?: AbortSignal; modelId?: string; now?: number; allowAuthInvalid?: boolean; excludeAccountKeys?: ReadonlySet<string>; }
export interface CodexCredentialSnapshot { readonly accessToken: string; readonly accountId: string; readonly accountKey: string; readonly refreshToken: string; readonly expiresAt: number; readonly authInvalidAt: number | null; }
function abortIfNeeded(signal?: AbortSignal) { if (signal?.aborted) throw new AccountSelectionError("ACCOUNT_SELECTION_ABORTED", "codex-multi account selection was aborted"); }
function eligible(a: Account, now: number, repair: boolean, modelId?: string) {
  const modelDeadlines = modelId === undefined ? [] : [a.rateLimitedUntilByModel?.[modelId], a.rateLimitedUntilByModel?.["*"]];
  const rateLimitedUntil = Math.max(a.rateLimitedUntil ?? 0, ...modelDeadlines.map(deadline => deadline ?? 0));
  return a.enabled && rateLimitedUntil <= now
    && (repair || a.authInvalidAt === null || a.authInvalidAt + AUTH_INVALID_COOLDOWN_MS <= now);
}
function unavailable(accounts: Account[]) { return new AccountSelectionError(accounts.length ? "ALL_ACCOUNTS_UNAVAILABLE" : "EMPTY_ACCOUNT_STORE", accounts.length ? "codex-multi has no eligible accounts (all are disabled or cooling down)" : "codex-multi has no configured accounts"); }
export async function selectAccount(store: AccountStore, options: AccountSelectionOptions = {}): Promise<CodexCredentialSnapshot> {
  abortIfNeeded(options.signal); const now = options.now ?? Date.now(); let snapshot!: CodexCredentialSnapshot;
  await store.mutate((current: Store) => {
    abortIfNeeded(options.signal);
    const candidates = current.accounts.filter(a => !options.excludeAccountKeys?.has(a.id) && eligible(a, now, !!options.allowAuthInvalid, options.modelId));
    if (!candidates.length) throw unavailable(current.accounts);
    const cursor = current.lastSelectedAccountId == null ? -1 : current.accounts.findIndex(a => a.id === current.lastSelectedAccountId);
    const start = cursor < 0 ? 0 : (cursor + 1) % current.accounts.length;
    const selected = Array.from({ length: current.accounts.length }, (_, i) => current.accounts[(start + i) % current.accounts.length]).find(a => !options.excludeAccountKeys?.has(a.id) && eligible(a, now, !!options.allowAuthInvalid, options.modelId));
    if (!selected) throw unavailable(current.accounts);
    snapshot = { accessToken: selected.accessToken, accountId: selected.accountId, accountKey: selected.id, refreshToken: selected.refreshToken, expiresAt: selected.expiresAt, authInvalidAt: selected.authInvalidAt };
    return { ...current, lastSelectedAccountId: selected.id, lastRotation: now, accounts: current.accounts.map(a => a.id === selected.id ? { ...a, usageCount: a.usageCount + 1, lastUsed: now } : a) };
  });
  abortIfNeeded(options.signal); return snapshot;
}
export function createAccountResolver(store: AccountStore) { return (signal?: AbortSignal, modelId?: string, excludeAccountKeys?: ReadonlySet<string>) => selectAccount(store, { signal, modelId, excludeAccountKeys }); }
