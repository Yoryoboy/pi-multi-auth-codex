import { describe, expect, it, vi } from "vitest";
import { runAccountManager } from "../src/ui/account-manager.js";
import type { AccountStore, Store } from "../src/accounts/store.js";

function harness(
  initial: Store,
  choices: Array<string | undefined>,
  uncertain = false,
) {
  let current = initial;
  const load = vi.fn(async () => current);
  const mutate = vi.fn(
    async (mutation: (store: Store) => Store | Promise<Store>) => {
      const next = await mutation(current);
      current = next;
      return uncertain ? ({ uncertain: true } as never) : next;
    },
  );
  const store = {
    load,
    mutate,
    path: "/tmp/accounts.json",
  } as unknown as AccountStore;
  const ui = {
    select: vi.fn(async () => choices.shift()),
    input: vi.fn(),
    confirm: vi.fn(),
    notify: vi.fn(),
  };
  const fetch = vi.fn();
  return { store, ui, fetch, load, mutate, value: () => current };
}

const emptyStore = (routingStrategy?: Store["routingStrategy"]): Store => ({
  version: 2,
  accounts: [],
  routingStrategy,
});

describe("account manager routing strategy", () => {
  it("shows the effective strategy and changes it without fetching quotas", async () => {
    const h = harness(emptyStore(), [
      "Routing strategy: Round robin",
      "Most available",
      undefined,
    ]);

    await runAccountManager({
      store: h.store,
      ui: h.ui,
      openBrowser: vi.fn(),
      fetch: h.fetch,
    });

    expect(h.ui.select).toHaveBeenNthCalledWith(
      1,
      "Codex accounts",
      expect.arrayContaining([
        "Add account",
        "Routing strategy: Round robin",
        "View all limits",
      ]),
    );
    expect(h.ui.select).toHaveBeenNthCalledWith(2, "Routing strategy", [
      "Round robin",
      "Most available",
      "Back",
    ]);
    expect(h.value().routingStrategy).toBe("most-available");
    expect(h.mutate).toHaveBeenCalledTimes(1);
    expect(h.ui.notify).toHaveBeenCalledWith(
      "Routing strategy changed to Most available.",
      "info",
    );
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it.each([[undefined], ["Back"], ["Round robin"]])(
    "does not write when dismissed or the active strategy is selected (%s)",
    async (selection) => {
      const h = harness(emptyStore("round-robin"), [
        "Routing strategy: Round robin",
        selection,
        undefined,
      ]);

      await runAccountManager({
        store: h.store,
        ui: h.ui,
        openBrowser: vi.fn(),
        fetch: h.fetch,
      });

      expect(h.mutate).not.toHaveBeenCalled();
      expect(h.ui.notify).not.toHaveBeenCalled();
      expect(h.fetch).not.toHaveBeenCalled();
    },
  );

  it("reloads once and warns without retrying an uncertain change", async () => {
    const h = harness(
      emptyStore("round-robin"),
      ["Routing strategy: Round robin", "Most available", undefined],
      true,
    );

    await runAccountManager({
      store: h.store,
      ui: h.ui,
      openBrowser: vi.fn(),
      fetch: h.fetch,
    });

    expect(h.mutate).toHaveBeenCalledTimes(1);
    expect(h.load).toHaveBeenCalledTimes(3);
    expect(h.ui.notify).toHaveBeenCalledWith(
      "Routing strategy update is uncertain; the store was reloaded. Do not retry blindly.",
      "warning",
    );
    expect(h.fetch).not.toHaveBeenCalled();
  });
});
