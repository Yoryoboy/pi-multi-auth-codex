import { describe, expect, it, vi } from "vitest";
import { createCodexMultiProvider, type CodexAccount } from "../src/provider.js";

describe("codex-multi provider", () => {
  it("registers gpt-5.6-sol without resolving credentials", () => {
    const registerProvider = vi.fn();
    createCodexMultiProvider({ resolveAccount: vi.fn() })({ registerProvider } as never);

    expect(registerProvider).toHaveBeenCalledOnce();
    const [name, definition] = registerProvider.mock.calls[0];
    expect(name).toBe("codex-multi");
    expect(definition.models.map((model: { id: string }) => model.id)).toEqual(["gpt-5.6-sol"]);
  });

  it("registers the provider thinking-level wire mapping", () => {
    const registerProvider = vi.fn();
    createCodexMultiProvider({ resolveAccount: vi.fn() })({ registerProvider } as never);

    const definition = registerProvider.mock.calls[0][1];
    expect(definition.models[0].thinkingLevelMap).toEqual({
      off: "none",
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    });
  });

  it("resolves request-scoped credentials into Responses headers", async () => {
    const account: CodexAccount = { accessToken: "fake-token", accountId: "fake-account", accountKey: "fake-key", refreshToken: "fake-refresh" };
    const resolveAccount = vi.fn().mockResolvedValue(account);
    const streamResponses = vi.fn().mockReturnValue((async function* () {})());
    const registerProvider = vi.fn();
    createCodexMultiProvider({ resolveAccount, streamResponses })({ registerProvider } as never);

    const definition = registerProvider.mock.calls[0][1];
    const model = definition.models[0];
    const context = { messages: [] };
    const options = { signal: new AbortController().signal };
    const result = definition.streamSimple(model, context, options);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result).toBeDefined();
    expect(resolveAccount).toHaveBeenCalledOnce();
    expect(resolveAccount).toHaveBeenCalledWith(options.signal, "gpt-5.6-sol");
    expect(streamResponses).toHaveBeenCalledWith(model, context, expect.objectContaining({
      apiKey: "fake-token",
      headers: {
        Authorization: "Bearer fake-token",
        "chatgpt-account-id": "fake-account",
      },
    }));
  });

  it("does not delegate transport when abort occurs after reservation", async () => {
        const controller = new AbortController();
        const resolveAccount = vi.fn().mockImplementation(async () => {
          const result = { accessToken: "reserved-token", accountId: "reserved-account" };
          controller.abort();
          return result;
        });
        const streamResponses = vi.fn();
        const registerProvider = vi.fn();
        createCodexMultiProvider({ resolveAccount, streamResponses })({ registerProvider } as never);
        const definition = registerProvider.mock.calls[0][1];
        const stream = definition.streamSimple(definition.models[0], { messages: [] }, { signal: controller.signal });
        for await (const event of stream) expect(event.type).toBe("error");
        expect(streamResponses).not.toHaveBeenCalled();
      });

      it("does not delegate transport when selection is cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const resolveAccount = vi.fn().mockRejectedValue(new Error("selection aborted"));
    const streamResponses = vi.fn();
    const registerProvider = vi.fn();
    createCodexMultiProvider({ resolveAccount, streamResponses })({ registerProvider } as never);
    const definition = registerProvider.mock.calls[0][1];
    const stream = definition.streamSimple(definition.models[0], { messages: [] }, { signal: controller.signal });
    for await (const event of stream) {
      expect(event.type).toBe("error");
    }
    expect(streamResponses).not.toHaveBeenCalled();
  });

  it.each(["accountKey", "refreshToken", "accessToken", "accountId"].flatMap(field => [undefined, "", " "].map(value => [field, value] as const)))("rejects credentials missing %s as %s without transport or secret leakage", async (missing, value) => {
        const partial: CodexAccount = { accessToken: "partial-access", accountId: "partial-account", accountKey: "partial-key", refreshToken: "partial-refresh" };
        (partial as any)[missing] = value;
        const streamResponses = vi.fn();
        const registerProvider = vi.fn();
        createCodexMultiProvider({ resolveAccount: vi.fn().mockResolvedValue(partial), streamResponses })({ registerProvider } as never);
        const definition = registerProvider.mock.calls[0][1];
        const events: any[] = [];
        for await (const event of definition.streamSimple(definition.models[0], { messages: [] }, {})) events.push(event);
        expect(streamResponses).not.toHaveBeenCalled();
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ type: "error" });
        expect(JSON.stringify(events)).not.toMatch(/partial-(access|account|key|refresh)/);
      });

      it("reports missing credentials as a configuration error", async () => {
    const registerProvider = vi.fn();
    createCodexMultiProvider({ resolveAccount: vi.fn().mockResolvedValue(undefined) })({ registerProvider } as never);
    const definition = registerProvider.mock.calls[0][1];
    const stream = definition.streamSimple(definition.models[0], { messages: [] }, {});
    const events: unknown[] = [];
    for await (const event of stream) events.push(event);

    expect(events.some((event: any) => event.type === "error" && /credentials/i.test(event.error?.errorMessage))).toBe(true);
  });
});
