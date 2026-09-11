import { randomUUID } from "node:crypto";
import type { Account, AccountStore } from "../accounts/store.js";
import { OAuthError, type OAuthTokens, tokenIdentity } from "./oauth.js";
import { validateAlias } from "../accounts/manage.js";
export type AccountUpsertErrorCode = "ACCOUNT_ALIAS_COLLISION" | "ACCOUNT_ID_DUPLICATE";
export class AccountUpsertError extends Error {
  readonly code: AccountUpsertErrorCode;
  constructor(code: AccountUpsertErrorCode, message: string) {
    super(message); this.code = code;
    Object.defineProperty(this, "name", { value: "AccountUpsertError", enumerable: false });
    Object.defineProperty(this, "code", { value: code, enumerable: false });
  }
}
export async function upsertOAuthAccount(store: AccountStore, alias: string, tokens: OAuthTokens, now = Date.now()): Promise<Account> {
  if (validateAlias(alias)) throw new AccountUpsertError("ACCOUNT_ALIAS_COLLISION", "Account alias is invalid");
  const identity = tokenIdentity(tokens, now); let result!: Account;
  await store.mutate(current => {
    const byAlias = current.accounts.find(a => a.alias === alias), byIdentity = current.accounts.find(a => a.accountId === identity.accountId);
    if (byAlias) throw new AccountUpsertError("ACCOUNT_ALIAS_COLLISION", "Account alias is already in use");
    if (byIdentity) throw new AccountUpsertError("ACCOUNT_ID_DUPLICATE", "Account identity is already configured");
    result = { alias, id: randomUUID(), accessToken: tokens.access_token, refreshToken: tokens.refresh_token ?? "", idToken: tokens.id_token, email: identity.email, planType: identity.planType, accountId: identity.accountId, expiresAt: identity.expiresAt, enabled: true, usageCount: 0, lastUsed: null, rateLimitedUntil: null, authInvalidAt: null };
    if (!result.refreshToken) throw new OAuthError("INVALID_TOKEN_RESPONSE", "OAuth response did not contain a refresh token");
    return { ...current, accounts: [...current.accounts, result] };
  }); return result;
}
