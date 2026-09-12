import type { FetchLike } from "../auth/oauth.js";
import { TokenManager } from "../auth/token-manager.js";
import { defaultAccountStore, type AccountResolver } from "../provider.js";
import { QuotaCache, resolveAccountQuotas } from "./quota.js";
import type { AccountStore } from "./store.js";

export interface DefaultAccountResolverOptions {
  fetch?: FetchLike;
  now?: () => number;
  quotaCache?: QuotaCache;
}

/** Build a quota-aware resolver whose quota reads prepare named accounts only. */
export function createDefaultAccountResolver(
  store: AccountStore,
  options: DefaultAccountResolverOptions = {},
): AccountResolver {
  const quotaCache = options.quotaCache ?? new QuotaCache();
  let manager: TokenManager;
  const quotaResolver = (
    accounts: Parameters<typeof resolveAccountQuotas>[0],
    signal?: AbortSignal,
  ) =>
    resolveAccountQuotas(accounts, quotaCache, {
      fetch: options.fetch,
      now: options.now,
      signal,
      tokenManager: manager,
    });
  manager = new TokenManager(store, {
    fetch: options.fetch,
    now: options.now,
    quotaResolver,
  });
  return (signal, modelId, excludeAccountKeys) =>
    manager.prepare(signal, modelId, { excludeAccountKeys });
}

/** Process-wide completed quota cache shared by default routing and status. */
export const defaultQuotaCache = new QuotaCache();
/** Process-wide resolver used by the default Pi extension provider. */
export const defaultAccountResolver = createDefaultAccountResolver(
  defaultAccountStore,
  { quotaCache: defaultQuotaCache },
);
