import {
  StoreCommitUncertainError,
  type AccountStore,
  type Account,
} from "../accounts/store.js";
import { upsertOAuthAccount } from "../auth/upsert.js";
import {
  loginAccount,
  type LoginOperation,
  type LoginOptions,
} from "../auth/oauth.js";
import {
  accountStatus,
  maskEmail,
  reauthenticateAccount,
  removeAccount,
  renderAccount,
  setAccountEnabled,
  setRoutingStrategy,
  validateAlias,
} from "../accounts/manage.js";
import {
  effectiveRoutingStrategy,
  type RoutingStrategy,
} from "../accounts/store.js";
import type { BrowserOpener } from "./browser.js";
import { fetchAllQuotas, formatQuotaSummary } from "../accounts/quota.js";
import type { FetchLike } from "../auth/oauth.js";

export interface AccountManagerUI {
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  notify(message: string, level: "info" | "warning" | "error"): void;
  waitForOAuth?: (
    operation: LoginOperation,
    controller: AbortController,
  ) => Promise<Awaited<LoginOperation> | null>;
}
export interface AccountManagerDeps {
  store: AccountStore;
  ui: AccountManagerUI;
  openBrowser: BrowserOpener;
  login?: (alias: string, options?: LoginOptions) => LoginOperation;
  now?: () => number;
  trackOAuth?: (
    controller: AbortController,
    operation: LoginOperation,
  ) => () => void;
  fetch?: FetchLike;
}

function safeError(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  )
    return `Account operation failed (${String((error as { code: string }).code)}).`;
  return "Account operation failed safely; no credentials were changed.";
}
function isAborted(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { code?: unknown }).code === "OAUTH_ABORTED"
  );
}
async function awaitLogin(
  deps: AccountManagerDeps,
  operation: LoginOperation,
  controller: AbortController,
): Promise<Awaited<LoginOperation> | null> {
  if (!deps.ui.waitForOAuth) {
    const flow = await operation.ready;
    try {
      await deps.openBrowser(flow.url);
    } catch {
      deps.ui.notify(
        "Browser could not be opened. Copy the authorization URL below; it contains OAuth state and challenge and must not be logged.",
        "warning",
      );
      deps.ui.notify(flow.url, "info");
    }
    return operation;
  }
  const ready = operation.ready.then(async (flow) => {
    try {
      await deps.openBrowser(flow.url);
    } catch {
      deps.ui.notify(
        "Browser could not be opened. Copy the authorization URL below; it contains OAuth state and challenge and must not be logged.",
        "warning",
      );
      deps.ui.notify(flow.url, "info");
    }
  });
  const result = await deps.ui.waitForOAuth(operation, controller);
  await ready.catch((error) => {
    if (!isAborted(error)) throw error;
  });
  return result;
}

export async function runAccountManager(
  deps: AccountManagerDeps,
): Promise<void> {
  const login = deps.login ?? loginAccount;
  while (true) {
    const store = await deps.store.load();
    const rows = store.accounts.map((account) =>
      renderAccount(account, store, deps.now?.() ?? Date.now()),
    );
    const strategy = effectiveRoutingStrategy(store);
    const strategyLabel =
      strategy === "round-robin" ? "Round robin" : "Most available";
    const routingAction = `Routing strategy: ${strategyLabel}`;
    const choice = await deps.ui.select("Codex accounts", [
      "Add account",
      ...rows,
      routingAction,
      "View all limits",
      "Refresh",
      "Show store path",
      "Close",
    ]);
    if (choice === undefined || choice === "Close") return;
    if (choice === routingAction) {
      await manageRoutingStrategy(deps, strategy);
      continue;
    }
    if (choice === "View all limits") {
      const quotas = await fetchAllQuotas(store.accounts, {
        store: deps.store,
        fetch: deps.fetch,
        now: deps.now,
      });
      deps.ui.notify(formatQuotaSummary(quotas), "info");
      continue;
    }
    if (choice === "Refresh") continue;
    if (choice === "Show store path") {
      deps.ui.notify(`Account store: ${deps.store.path}`, "info");
      continue;
    }
    if (choice === "Add account") {
      await addAccount(deps, login);
      continue;
    }
    const index = rows.indexOf(choice);
    if (index >= 0) await manageAccount(deps, store.accounts[index]!, login);
  }
}

async function manageRoutingStrategy(
  deps: AccountManagerDeps,
  current: RoutingStrategy,
): Promise<void> {
  const selected = await deps.ui.select("Routing strategy", [
    "Round robin",
    "Most available",
    "Back",
  ]);
  if (selected === undefined || selected === "Back") return;
  const strategy: RoutingStrategy =
    selected === "Round robin" ? "round-robin" : "most-available";
  if (strategy === current) return;
  const result = await setRoutingStrategy(deps.store, strategy);
  if ("uncertain" in result) {
    await deps.store.load();
    deps.ui.notify(
      "Routing strategy update is uncertain; the store was reloaded. Do not retry blindly.",
      "warning",
    );
    return;
  }
  deps.ui.notify(`Routing strategy changed to ${selected}.`, "info");
}

async function addAccount(
  deps: AccountManagerDeps,
  login: AccountManagerDeps["login"],
): Promise<void> {
  const alias = await deps.ui.input("New account alias", "work");
  if (alias === undefined) return;
  const problem = validateAlias(alias);
  if (problem) {
    deps.ui.notify(problem, "error");
    return;
  }
  const controller = new AbortController();
  let operation: LoginOperation | undefined;
  let untrack: (() => void) | undefined;
  try {
    operation = login!(alias, { signal: controller.signal });
    untrack = deps.trackOAuth?.(controller, operation);
    const result = await awaitLogin(deps, operation, controller);
    if (!result) return;
    await upsertOAuthAccount(deps.store, alias, result.tokens);
    deps.ui.notify(
      `Account ${alias} authenticated as ${maskEmail(result.identity.email)}.`,
      "info",
    );
  } catch (error) {
    if (error instanceof StoreCommitUncertainError) {
      await deps.store.load();
      deps.ui.notify(
        "Account save is uncertain; the store was reloaded. Do not retry blindly.",
        "warning",
      );
    } else if (!isAborted(error)) deps.ui.notify(safeError(error), "error");
  } finally {
    controller.abort();
    if (operation) await operation.catch(() => undefined);
    untrack?.();
  }
}

async function manageAccount(
  deps: AccountManagerDeps,
  account: Account,
  login: AccountManagerDeps["login"],
): Promise<void> {
  const selected = await deps.ui.select(`Manage ${account.alias}`, [
    account.enabled ? "Disable" : "Enable",
    "Reauthenticate",
    "Remove",
    "Back",
  ]);
  if (selected === undefined || selected === "Back") return;
  if (selected === "Enable" || selected === "Disable") {
    try {
      const result = await setAccountEnabled(
        deps.store,
        account.id,
        selected === "Enable",
      );
      if ("uncertain" in result) {
        await deps.store.load();
        deps.ui.notify(
          "Account update is uncertain; the store was reloaded. Do not retry blindly.",
          "warning",
        );
        return;
      }
      deps.ui.notify(
        `Account ${account.alias} ${selected.toLowerCase()}d.`,
        "info",
      );
      return;
    } catch (error) {
      if (error instanceof StoreCommitUncertainError) {
        await deps.store.load();
        deps.ui.notify(
          "Account update is uncertain; the store was reloaded. Do not retry blindly.",
          "warning",
        );
        return;
      }
      throw error;
    }
  }
  if (selected === "Remove") {
    if (
      !(await deps.ui.confirm(
        "Remove account?",
        `Remove ${account.alias}? Tokens will be deleted from the account store.`,
      ))
    )
      return;
    try {
      const result = await removeAccount(deps.store, account.id);
      if ("uncertain" in result) {
        await deps.store.load();
        deps.ui.notify(
          "Account removal is uncertain; the store was reloaded. Do not retry blindly.",
          "warning",
        );
      } else deps.ui.notify(`Account ${account.alias} removed.`, "info");
    } catch (error) {
      if (error instanceof StoreCommitUncertainError) {
        await deps.store.load();
        deps.ui.notify(
          "Account removal is uncertain; the store was reloaded. Do not retry blindly.",
          "warning",
        );
        return;
      }
      throw error;
    }
    return;
  }
  const controller = new AbortController();
  let operation: LoginOperation | undefined;
  let untrack: (() => void) | undefined;
  const expected = {
    accessToken: account.accessToken,
    refreshToken: account.refreshToken,
    accountId: account.accountId,
  };
  try {
    operation = login!(account.alias, { signal: controller.signal });
    untrack = deps.trackOAuth?.(controller, operation);
    const result = await awaitLogin(deps, operation, controller);
    if (!result) return;
    const updated = await reauthenticateAccount(
      deps.store,
      account.id,
      result.tokens,
      deps.now?.() ?? Date.now(),
      expected,
    );
    if ("uncertain" in updated) {
      await deps.store.load();
      deps.ui.notify(
        "Reauthentication is uncertain; the store was reloaded. Do not retry blindly.",
        "warning",
      );
    } else
      deps.ui.notify(
        `Account ${account.alias} reauthenticated as ${maskEmail(result.identity.email)}.`,
        "info",
      );
  } catch (error) {
    if (error instanceof StoreCommitUncertainError) {
      await deps.store.load();
      deps.ui.notify(
        "Reauthentication is uncertain; the store was reloaded. Do not retry blindly.",
        "warning",
      );
    } else if (!isAborted(error)) deps.ui.notify(safeError(error), "error");
  } finally {
    controller.abort();
    if (operation) await operation.catch(() => undefined);
    untrack?.();
  }
}

export { accountStatus };
