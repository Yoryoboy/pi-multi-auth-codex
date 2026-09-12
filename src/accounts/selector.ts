import type { QuotaResult } from "./quota.js";
import type { Account, AccountStore, Store } from "./store.js";
export const AUTH_INVALID_COOLDOWN_MS = 5 * 60 * 1_000;

export function rankMostAvailableAccount(
  cursorOrderedAccounts: readonly Account[],
  observations: ReadonlyMap<string, QuotaResult>,
): Account | undefined {
  let winner: Account | undefined;
  let winningScore: number | undefined;

  for (const account of cursorOrderedAccounts) {
    const result = observations.get(account.id);
    if (
      result?.status !== "ok" ||
      !result.quota?.fiveHour ||
      !result.quota.weekly
    )
      continue;
    const score = Math.min(
      result.quota.fiveHour.remainingPercent,
      result.quota.weekly.remainingPercent,
    );
    if (winningScore === undefined || score > winningScore) {
      winner = account;
      winningScore = score;
    }
  }

  return winner;
}
export type AccountSelectionErrorCode =
  | "EMPTY_ACCOUNT_STORE"
  | "ALL_ACCOUNTS_UNAVAILABLE"
  | "ACCOUNT_SELECTION_ABORTED";
export class AccountSelectionError extends Error {
  readonly code: AccountSelectionErrorCode;
  constructor(code: AccountSelectionErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "AccountSelectionError";
  }
}
export interface AccountSelectionOptions {
  signal?: AbortSignal;
  modelId?: string;
  now?: number;
  allowAuthInvalid?: boolean;
  excludeAccountKeys?: ReadonlySet<string>;
  quotaResolver?: (
    accounts: readonly Account[],
    signal?: AbortSignal,
  ) => Promise<ReadonlyMap<string, QuotaResult>>;
}
export interface CodexCredentialSnapshot {
  readonly accessToken: string;
  readonly accountId: string;
  readonly accountKey: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
  readonly authInvalidAt: number | null;
}
function abortIfNeeded(signal?: AbortSignal) {
  if (signal?.aborted)
    throw new AccountSelectionError(
      "ACCOUNT_SELECTION_ABORTED",
      "codex-multi account selection was aborted",
    );
}
function eligible(a: Account, now: number, repair: boolean, modelId?: string) {
  const modelDeadlines =
    modelId === undefined
      ? []
      : [
          a.rateLimitedUntilByModel?.[modelId],
          a.rateLimitedUntilByModel?.["*"],
        ];
  const rateLimitedUntil = Math.max(
    a.rateLimitedUntil ?? 0,
    ...modelDeadlines.map((deadline) => deadline ?? 0),
  );
  return (
    a.enabled &&
    rateLimitedUntil <= now &&
    (repair ||
      a.authInvalidAt === null ||
      a.authInvalidAt + AUTH_INVALID_COOLDOWN_MS <= now)
  );
}
function unavailable(accounts: Account[]) {
  return new AccountSelectionError(
    accounts.length ? "ALL_ACCOUNTS_UNAVAILABLE" : "EMPTY_ACCOUNT_STORE",
    accounts.length
      ? "codex-multi has no eligible accounts (all are disabled or cooling down)"
      : "codex-multi has no configured accounts",
  );
}
function cursorOrderedEligible(
  current: Store,
  options: AccountSelectionOptions,
  now: number,
): Account[] {
  const cursor =
    current.lastSelectedAccountId == null
      ? -1
      : current.accounts.findIndex(
          (a) => a.id === current.lastSelectedAccountId,
        );
  const start = cursor < 0 ? 0 : (cursor + 1) % current.accounts.length;
  return Array.from(
    { length: current.accounts.length },
    (_, i) => current.accounts[(start + i) % current.accounts.length],
  ).filter(
    (a) =>
      !options.excludeAccountKeys?.has(a.id) &&
      eligible(a, now, !!options.allowAuthInvalid, options.modelId),
  );
}

export async function selectAccount(
  store: AccountStore,
  options: AccountSelectionOptions = {},
): Promise<CodexCredentialSnapshot> {
  abortIfNeeded(options.signal);
  const now = options.now ?? Date.now();
  let observations: ReadonlyMap<string, QuotaResult> | undefined;
  if (options.quotaResolver) {
    const initial = await store.load();
    if ((initial.routingStrategy ?? "round-robin") === "most-available") {
      const candidates = cursorOrderedEligible(initial, options, now);
      if (!candidates.length) throw unavailable(initial.accounts);
      observations = await options.quotaResolver(candidates, options.signal);
      abortIfNeeded(options.signal);
    }
  }

  let snapshot!: CodexCredentialSnapshot;
  await store.mutate((current: Store) => {
    abortIfNeeded(options.signal);
    const candidates = cursorOrderedEligible(current, options, now);
    if (!candidates.length) throw unavailable(current.accounts);
    const selected =
      (current.routingStrategy ?? "round-robin") === "most-available" &&
      observations
        ? (rankMostAvailableAccount(candidates, observations) ?? candidates[0])
        : candidates[0];
    snapshot = {
      accessToken: selected.accessToken,
      accountId: selected.accountId,
      accountKey: selected.id,
      refreshToken: selected.refreshToken,
      expiresAt: selected.expiresAt,
      authInvalidAt: selected.authInvalidAt,
    };
    return {
      ...current,
      lastSelectedAccountId: selected.id,
      lastRotation: now,
      accounts: current.accounts.map((a) =>
        a.id === selected.id
          ? { ...a, usageCount: a.usageCount + 1, lastUsed: now }
          : a,
      ),
    };
  });
  abortIfNeeded(options.signal);
  return snapshot;
}
export function createAccountResolver(store: AccountStore) {
  return (
    signal?: AbortSignal,
    modelId?: string,
    excludeAccountKeys?: ReadonlySet<string>,
  ) => selectAccount(store, { signal, modelId, excludeAccountKeys });
}
