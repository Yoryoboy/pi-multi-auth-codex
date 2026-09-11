import { mkdir, rmdir, stat, utimes } from "node:fs";
import { mkdir as mkdirAsync, open, readFile, rename, rm, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";

export interface Account {
  alias: string;
  id: string;
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  email?: string;
  planType?: string;
  accountId: string;
  expiresAt: number;
  enabled: boolean;
  usageCount: number;
  lastUsed: number | null;
  rateLimitedUntil: number | null;
  authInvalidAt: number | null;
}

export interface Store {
  version: 2;
  accounts: Account[];
  /** Stable identity of the account selected most recently. */
  lastSelectedAccountId?: string | null;
  lastRotation?: number | null;
}

export const DEFAULT_STORE_PATH = join(homedir(), ".pi", "agent", "pi-multi-auth-codex", "accounts.json");
const LOCK_UPDATE_MS = 5_000;
const LOCK_STALE_MS = 30_000;
const LOCK_RETRIES = { retries: 50, minTimeout: 10, maxTimeout: 100 };
const lockFs = { mkdir, rmdir, stat, utimes };

export interface AccountStoreOptions {
  path?: string;
}

export type StoreMutation = (store: Store) => Store | Promise<Store>;

/** The rename committed the mutation, but a required post-commit step failed. Reload before retrying. */
export class StoreCommitUncertainError extends Error {
  readonly code = "STORE_COMMIT_UNCERTAIN";

  constructor() {
    super("Account store mutation may have committed; reload the store before retrying");
    this.name = "StoreCommitUncertainError";
  }
}

function invalidStore(): Error {
  return new Error("Invalid account store");
}

function isTimestamp(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function validateAccount(value: unknown): asserts value is Account {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidStore();
  const account = value as Record<string, unknown>;
  const allowedKeys = new Set([
    "alias", "id", "accessToken", "refreshToken", "idToken", "email", "planType",
    "accountId", "expiresAt", "enabled", "usageCount", "lastUsed", "rateLimitedUntil", "authInvalidAt",
  ]);
  if (Object.keys(account).some((key) => !allowedKeys.has(key))) throw invalidStore();
  const requiredStrings = ["alias", "id", "accessToken", "refreshToken", "accountId"];
  if (requiredStrings.some((key) => typeof account[key] !== "string" || account[key] === "")) throw invalidStore();
  for (const key of ["idToken", "email", "planType"]) {
    if (key in account && account[key] !== undefined && typeof account[key] !== "string") throw invalidStore();
  }
  if (typeof account.expiresAt !== "number" || !Number.isFinite(account.expiresAt) || account.expiresAt < 0) throw invalidStore();
  if (typeof account.enabled !== "boolean" || typeof account.usageCount !== "number" || !Number.isInteger(account.usageCount) || account.usageCount < 0) throw invalidStore();
  if (!isTimestamp(account.lastUsed) || !isTimestamp(account.rateLimitedUntil) || !isTimestamp(account.authInvalidAt)) throw invalidStore();
}

function validateStore(value: unknown): asserts value is Store {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidStore();
  const store = value as Record<string, unknown>;
  if (Object.keys(store).some((key) => !["version", "accounts", "lastSelectedAccountId", "lastRotation"].includes(key))) throw invalidStore();
  if (store.version !== 2 || !Array.isArray(store.accounts)) throw invalidStore();
  if ("lastSelectedAccountId" in store && store.lastSelectedAccountId !== null
     && (typeof store.lastSelectedAccountId !== "string" || store.lastSelectedAccountId === "")) throw invalidStore();
  if ("lastRotation" in store && !isTimestamp(store.lastRotation)) throw invalidStore();
  for (const account of store.accounts) validateAccount(account);
}

function migrateV1(value: unknown): Store {
     if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidStore();
     const old = value as Record<string, unknown>;
     if (old.version !== 1 || !Array.isArray(old.accounts)
       || Object.keys(old).some((key) => !["version", "accounts", "rotationIndex", "lastRotation"].includes(key))) throw invalidStore();
     if ("rotationIndex" in old && (typeof old.rotationIndex !== "number" || !Number.isInteger(old.rotationIndex) || old.rotationIndex < 0)) throw invalidStore();
     if ("lastRotation" in old && !isTimestamp(old.lastRotation)) throw invalidStore();
     for (const account of old.accounts) validateAccount(account);
     const migrated: Store = { version: 2, accounts: old.accounts as Account[] };
     if ("lastRotation" in old) migrated.lastRotation = old.lastRotation as number | null;
     return migrated;
   }

   const emptyStore = (): Store => ({ version: 2, accounts: [] });

export class AccountStore {
  readonly path: string;
  
  private localMutation: Promise<void> = Promise.resolve();

  constructor(options: AccountStoreOptions = {}) {
    this.path = options.path ?? DEFAULT_STORE_PATH;
  }

  async load(): Promise<Store> {
    return this.withLock(async () => this.readOrInitialize());
  }

  async mutate(mutation: StoreMutation): Promise<Store> {
    let result!: Store;
    const operation = this.localMutation.then(async () => {
      result = await this.withLock(async () => {
        const current = await this.readOrInitialize();
        const next = await mutation(current);
        validateStore(next);
        await this.writeAtomically(next);
        return next;
      });
    });
    this.localMutation = operation.then(() => undefined, () => undefined);
    await operation;
    return result;
  }

  private async readOrInitialize(): Promise<Store> {
    await mkdirAsync(dirname(this.path), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.path), 0o700);
    try {
      const raw = await readFile(this.path, "utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw invalidStore();
      }
      let current: Store;
          if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
            && (parsed as Record<string, unknown>).version === 1
            ) {
                current = migrateV1(parsed);
                await this.writeAtomically(current);
              } else {
                validateStore(parsed);
                current = parsed;
                  }


          
          
      await chmod(this.path, 0o600);
      return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const initial = emptyStore();
      await this.writeAtomically(initial);
      return initial;
    }
  }

  private async writeAtomically(store: Store): Promise<void> {
    const directory = dirname(this.path);
    await mkdirAsync(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporaryPath = join(directory, `.${this.path.split("/").pop() ?? "accounts"}.${randomUUID()}.tmp`);
    let handle;
    let committed = false;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(store)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      // Establish private permissions before rename: the committed file is never permissive.
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, this.path);
      committed = true;
      try {
        const directoryHandle = await open(directory, "r");
        try {
          await directoryHandle.sync();
        } finally {
          await directoryHandle.close();
        }
      } catch (error) {
        throw new StoreCommitUncertainError();
      }
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      if (!committed) await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Mutation callbacks run while this lock is held and must stay short and local;
   * network work is forbidden inside mutate.
   */
  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdirAsync(dirname(this.path), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.path), 0o700);
    // An explicit sibling lock path plus realpath:false lets proper-lockfile acquire via
    // atomic mkdir before the account file exists; first load initializes it under lock.
    const release = await lockfile.lock(this.path, {
      lockfilePath: `${this.path}.lock`,
      realpath: false,
      fs: lockFs,
      stale: LOCK_STALE_MS,
      update: LOCK_UPDATE_MS,
      retries: LOCK_RETRIES,
      onCompromised: (error) => { throw error; },
    });
    try {
      return await operation();
    } finally {
      await release();
    }
  }
}

export function createAccountStore(options: AccountStoreOptions = {}): AccountStore {
  return new AccountStore(options);
}
