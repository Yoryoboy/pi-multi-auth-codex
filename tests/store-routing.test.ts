import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AccountStore,
  effectiveRoutingStrategy,
  type Store,
} from "../src/accounts/store.js";

async function writeStore(value: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-multi-auth-routing-"));
  const path = join(directory, "nested", "accounts.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value));
  return path;
}

describe("store routing strategy", () => {
  it("defaults an absent strategy to round-robin without mutating the store", () => {
    const store: Store = { version: 2, accounts: [] };

    expect(effectiveRoutingStrategy(store)).toBe("round-robin");
    expect(store).toEqual({ version: 2, accounts: [] });
  });

  it("returns a persisted most-available strategy", async () => {
    const path = await writeStore({
      version: 2,
      accounts: [],
      routingStrategy: "most-available",
    });
    const store = await new AccountStore({ path }).load();

    expect(store.routingStrategy).toBe("most-available");
    expect(effectiveRoutingStrategy(store)).toBe("most-available");
  });

  it.each([null, "", "least-used", 1, false])(
    "strictly rejects a present invalid strategy: %j",
    async (routingStrategy) => {
      const path = await writeStore({
        version: 2,
        accounts: [],
        routingStrategy,
      });

      await expect(new AccountStore({ path }).load()).rejects.toThrow(
        /invalid account store/i,
      );
    },
  );
});
