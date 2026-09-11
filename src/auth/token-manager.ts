import { selectAccount } from "../accounts/selector.js";
import type { Account, AccountStore } from "../accounts/store.js";
import { OAuthError, refreshOAuthToken, tokenIdentity, type FetchLike } from "./oauth.js";

export type TokenManagerErrorCode = "TOKEN_REFRESH_INVALID" | "TOKEN_REFRESH_FAILED" | "TOKEN_REFRESH_CONFLICT";
export class TokenManagerError extends Error {
  readonly code: TokenManagerErrorCode; readonly accountKey?: string;
  constructor(code: TokenManagerErrorCode, message: string, accountKey?: string) { super(message); this.code = code; this.accountKey = accountKey; Object.defineProperty(this, "name", { value: "TokenManagerError", enumerable: false }); Object.defineProperty(this, "code", { value: code, enumerable: false }); Object.defineProperty(this, "accountKey", { value: accountKey, enumerable: false }); }
}
export interface TokenManagerOptions { fetch?: FetchLike; now?: () => number; bufferMs?: number; excludeAccountKeys?: ReadonlySet<string>; }
export interface PreparedCredentials { readonly accessToken: string; readonly accountId: string; readonly accountKey: string; readonly refreshToken: string; }
const abort = (signal?: AbortSignal) => { if (signal?.aborted) throw new OAuthError("OAUTH_ABORTED", "Request was aborted"); };

export class TokenManager {
  constructor(private readonly store: AccountStore, private readonly options: TokenManagerOptions = {}) {}
  async prepare(signal?: AbortSignal, modelId?: string, requestOptions?: { excludeAccountKeys?: ReadonlySet<string> }): Promise<PreparedCredentials> {
    const now = this.options.now?.() ?? Date.now();
    const selected = await selectAccount(this.store, { signal, modelId, now, excludeAccountKeys: requestOptions?.excludeAccountKeys ?? this.options.excludeAccountKeys });
    return this.prepareAccount(selected.accountKey, signal, true);
  }
  /** Prepare one named account without invoking account selection or rotation. */
  async prepareAccount(accountKey: string, signal?: AbortSignal, mutateHealth = true, _observed?: Account): Promise<PreparedCredentials> {
    const now = this.options.now?.() ?? Date.now();
    const current = (await this.store.load()).accounts.find(account => account.id === accountKey);
    if (!current) throw new TokenManagerError("TOKEN_REFRESH_FAILED", "Requested account credentials are unavailable", accountKey);
    abort(signal);
    const buffer = this.options.bufferMs ?? 5 * 60_000;
    if (current.authInvalidAt === null && current.expiresAt > now + buffer) return { accessToken: current.accessToken, accountId: current.accountId, accountKey: current.id, refreshToken: current.refreshToken };
    let tokens;
    try { tokens = await refreshOAuthToken(current.refreshToken, { fetch: this.options.fetch, signal }); }
    catch (error) {
      if (error instanceof OAuthError && (error.status === 401 || error.status === 403)) {
        if (mutateHealth) await this.store.mutate(store => { abort(signal); return { ...store, accounts: store.accounts.map(account => account.id === current.id && account.refreshToken === current.refreshToken && account.accessToken === current.accessToken ? { ...account, authInvalidAt: now } : account) }; });
        throw new TokenManagerError("TOKEN_REFRESH_INVALID", "Requested account refresh was rejected", accountKey);
      }
      if (error instanceof OAuthError && error.code === "OAUTH_ABORTED") throw error;
      throw new TokenManagerError("TOKEN_REFRESH_FAILED", "Requested account token refresh failed", accountKey);
    }
    abort(signal);
    let identity;
    try { identity = tokenIdentity(tokens, now); }
    catch (error) { if (error instanceof OAuthError) throw new TokenManagerError("TOKEN_REFRESH_FAILED", "Requested account token identity was rejected", accountKey); throw error; }
    if (identity.accountId !== current.accountId) throw new TokenManagerError("TOKEN_REFRESH_FAILED", "Requested account token identity was rejected", accountKey);
    const nextRefresh = tokens.refresh_token ?? current.refreshToken; let committed = false;
    await this.store.mutate(store => { abort(signal); const account = store.accounts.find(item => item.id === current.id); if (!account || account.refreshToken !== current.refreshToken || account.accessToken !== current.accessToken) return store; committed = true; return { ...store, accounts: store.accounts.map(item => item.id === current.id ? { ...item, accessToken: tokens.access_token, refreshToken: nextRefresh, idToken: tokens.id_token ?? item.idToken, accountId: identity.accountId ?? item.accountId, email: identity.email ?? item.email, planType: identity.planType ?? item.planType, expiresAt: identity.expiresAt, authInvalidAt: mutateHealth ? null : item.authInvalidAt } : item) }; });
    abort(signal);
    if (committed) return { accessToken: tokens.access_token, accountId: identity.accountId, accountKey: current.id, refreshToken: nextRefresh };
    const newer = (await this.store.load()).accounts.find(item => item.id === current.id);
    if (newer && (newer.refreshToken !== current.refreshToken || newer.accessToken !== current.accessToken)) return { accessToken: newer.accessToken, accountId: newer.accountId, accountKey: newer.id, refreshToken: newer.refreshToken };
    throw new TokenManagerError("TOKEN_REFRESH_CONFLICT", "Requested account changed during token refresh", accountKey);
  }
}
export function createTokenManager(store: AccountStore, options?: TokenManagerOptions) { return new TokenManager(store, options); }
