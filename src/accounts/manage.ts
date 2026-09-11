import type { Account, AccountStore } from "./store.js";
import { StoreCommitUncertainError } from "./store.js";
import { tokenIdentity, type OAuthTokens } from "../auth/oauth.js";

export const ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
export function validateAlias(alias: string): string | undefined {
  if (!ALIAS_PATTERN.test(alias)) return "Alias must be 1-32 characters: letters, numbers, dot, dash, or underscore.";
}

export type AccountStatus = "available" | "rate-limited" | "auth-cooldown" | "expired" | "disabled";
export function accountStatus(account: Account, now = Date.now()): AccountStatus {
  if (!account.enabled) return "disabled";
  if (account.rateLimitedUntil !== null && account.rateLimitedUntil > now) return "rate-limited";
  if (account.authInvalidAt !== null && account.authInvalidAt + 300_000 > now) return "auth-cooldown";
  if (account.expiresAt <= now) return "expired";
  return "available";
}
const REDACTED_EMAIL = "[redacted email]";
export function maskEmail(email?: string): string {
  if (typeof email !== "string" || email.length === 0 || /\s/.test(email)) return REDACTED_EMAIL;
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1 || email.indexOf("@") !== at) return REDACTED_EMAIL;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (!/^[^@]+$/.test(local) || !/^[A-Za-z0-9.-]+$/.test(domain)) return REDACTED_EMAIL;
  const masked = `[redacted local]@${domain}`;
  // A claim can intentionally be adversarial (for example, "[redacted local]").
  // Never return a rendering that is byte-for-byte equal to the claim.
  return masked === email ? REDACTED_EMAIL : masked;
}
export function renderAccount(account: Account, store: { lastSelectedAccountId?: string | null }, now = Date.now()): string {
  const marker = store.lastSelectedAccountId === account.id ? "*" : " ";
  return `${marker} ${account.alias} | ${maskEmail(account.email)} | ${account.enabled ? "enabled" : "disabled"} | ${accountStatus(account, now)}`;
}

export type ManageMutationResult = { account: Account } | { uncertain: true };
export async function setAccountEnabled(store: AccountStore, id: string, enabled: boolean): Promise<ManageMutationResult> {
  try {
    let account!: Account;
    await store.mutate(current => {
      const found = current.accounts.find(value => value.id === id);
      if (!found) return current;
      account = { ...found, enabled };
      return { ...current, accounts: current.accounts.map(value => value.id === id ? account : value) };
    });
    return { account };
  } catch (error) { if (error instanceof StoreCommitUncertainError) return { uncertain: true }; throw error; }
}

export async function removeAccount(store: AccountStore, id: string): Promise<ManageMutationResult> {
  try {
    let account!: Account;
    await store.mutate(current => {
      account = current.accounts.find(value => value.id === id)!;
      if (!account) return current;
      const accounts = current.accounts.filter(value => value.id !== id);
      const removedIndex = current.accounts.findIndex(value => value.id === id);
      const predecessor = removedIndex > 0 ? current.accounts[removedIndex - 1]?.id : current.accounts.at(-1)?.id;
      return { ...current, accounts, lastSelectedAccountId: current.lastSelectedAccountId === id ? (accounts.length === 0 ? null : predecessor ?? null) : current.lastSelectedAccountId };
    });
    return { account };
  } catch (error) { if (error instanceof StoreCommitUncertainError) return { uncertain: true }; throw error; }
}

export interface ReauthenticationExpectation { accessToken: string; refreshToken: string; accountId: string; }
export class ReauthenticationConflictError extends Error {
  readonly code = "REAUTHENTICATION_CONFLICT";
  constructor() {
    super("Account changed during reauthentication; no credentials were overwritten");
    Object.defineProperty(this, "name", { value: "ReauthenticationConflictError", enumerable: false });
    Object.defineProperty(this, "code", { value: this.code, enumerable: false });
  }
}
export async function reauthenticateAccount(store: AccountStore, id: string, tokens: OAuthTokens, now: number, expected: ReauthenticationExpectation): Promise<ManageMutationResult> {
  const identity = tokenIdentity(tokens, now);
  try {
    let account!: Account;
    await store.mutate(current => {
      const found = current.accounts.find(value => value.id === id);
      if (!found) throw new Error("Account no longer exists");
      if (found.accountId !== identity.accountId) throw new Error("OAuth identity does not match the selected account");
      if (found.id !== id || found.accountId !== expected.accountId || found.accessToken !== expected.accessToken || found.refreshToken !== expected.refreshToken) throw new ReauthenticationConflictError();
      account = { ...found, accessToken: tokens.access_token, refreshToken: tokens.refresh_token ?? found.refreshToken, idToken: tokens.id_token ?? found.idToken, email: identity.email ?? found.email, planType: identity.planType ?? found.planType, expiresAt: identity.expiresAt, authInvalidAt: null, rateLimitedUntil: null };
      return { ...current, accounts: current.accounts.map(value => value.id === id ? account : value) };
    });
    return { account };
  } catch (error) { if (error instanceof StoreCommitUncertainError) return { uncertain: true }; throw error; }
}
