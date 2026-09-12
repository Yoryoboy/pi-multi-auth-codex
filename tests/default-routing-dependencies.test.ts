import { describe, expect, it, vi } from "vitest";
import extension from "../src/index.js";
import { AccountStore } from "../src/accounts/store.js";

function harness() {
  const handlers: Record<string, (...args: any[]) => Promise<void>> = {};
  const registerProvider = vi.fn();
  return {
    pi: {
      registerProvider,
      registerCommand: vi.fn(
        (
          name: string,
          command: { handler: (...args: any[]) => Promise<void> },
        ) => {
          handlers[name] = command.handler;
        },
      ),
      on: vi.fn(),
    } as never,
    handlers,
    registerProvider,
  };
}

describe("default routing dependency wiring", () => {
  it("creates one stable provider store while preserving fresh UI stores", async () => {
    const providerStore = new AccountStore({
      path: "/tmp/provider-accounts.json",
    });
    const uiStore = new AccountStore({ path: "/tmp/ui-accounts.json" });
    const createStore = vi
      .fn()
      .mockReturnValueOnce(providerStore)
      .mockReturnValueOnce(uiStore);
    const runAccountManager = vi.fn().mockResolvedValue(undefined);
    const h = harness();

    extension(h.pi, { createStore, fetch: vi.fn(), runAccountManager });

    expect(createStore).toHaveBeenCalledOnce();
    const context = {
      hasUI: true,
      mode: "tui",
      ui: { notify: vi.fn() },
    } as never;
    await h.handlers["codex-accounts"]([], context);
    expect(runAccountManager).toHaveBeenCalledWith(
      expect.objectContaining({ store: uiStore }),
    );
    expect(createStore).toHaveBeenCalledTimes(2);
  });
});
