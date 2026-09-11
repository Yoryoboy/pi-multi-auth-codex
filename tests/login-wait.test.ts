import { describe, expect, it, vi } from "vitest";
import { waitForOAuth } from "../src/ui/login-wait.js";

function operation() {
  let resolve!: (value: any) => void;
  const result: any = new Promise((r) => { resolve = r; });
  result.ready = Promise.resolve({ url: "https://auth.example.test", state: "s", redirectUri: "http://localhost", port: 1455, pkce: { verifier: "v", challenge: "c" } });
  result.getFlow = () => undefined;
  return { result, resolve };
}

describe("OAuth wait component", () => {
  it("keeps configured cancellation pending until OAuth cleanup, then resolves null", async () => {
    const pending = operation();
    let component: any;
    let complete!: (value: any) => void;
    const ui = { custom: vi.fn((factory: any) => new Promise(resolve => {
      complete = resolve;
      component = factory({ requestRender: vi.fn() }, { fg: (_: string, s: string) => s }, { matches: (data: string, action: string) => data === "cancel" && action === "tui.select.cancel" }, (value: any) => resolve(value));
    })) } as any;
    const controller = new AbortController();
    const waiting = waitForOAuth(ui, pending.result, controller);
    await Promise.resolve();
    component.handleInput("cancel");
    expect(controller.signal.aborted).toBe(true);
    let settled = false;
    void waiting.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    pending.resolve({ alias: "a", tokens: {}, identity: {} });
    await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
    await waiting;
    expect(settled).toBe(true);
    expect(ui.custom).toHaveBeenCalledOnce();
  });

  it("resolves successful OAuth through done", async () => {
    const pending = operation();
    const value = { alias: "a", tokens: {}, identity: {} };
    let done!: (value: any) => void;
    const ui = { custom: vi.fn((factory: any) => new Promise(resolve => {
      done = (value: any) => { resolve(value); };
      factory({ requestRender: vi.fn() }, { fg: (_: string, s: string) => s }, { matches: () => false }, done);
    })) } as any;
    const waiting = waitForOAuth(ui, pending.result, new AbortController());
    pending.resolve(value);
    await expect(waiting).resolves.toEqual(value);
  });
});
