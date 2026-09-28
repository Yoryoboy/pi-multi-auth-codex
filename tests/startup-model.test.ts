import { describe, expect, it, vi } from "vitest";

/**
 * Pi 0.87.1 aliases `@earendil-works/pi-ai/providers/all` to the running host
 * bundle, while the extension's own locked pi-ai dependency (0.85.1) has an
 * older Codex catalog. This fixture stands in for the host bundle and ships
 * `gpt-6-sol`, a model the locked catalog does not know about.
 */
const hostCatalog = vi.hoisted(() => {
  const modelIds = [
    "gpt-5.3-codex-spark",
    "gpt-5.5",
    "gpt-5.6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-6-astra",
    "gpt-6-luna",
    "gpt-6-sol",
  ];
  const models = modelIds.map((id) => ({
    id,
    provider: "openai-codex",
    api: "openai-codex-responses",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    name: id,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 128000,
  }));
  return { modelIds, models };
});

vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  getBuiltinModels: (provider: string) =>
    provider === "openai-codex" ? hostCatalog.models : [],
  getBuiltinModel: (provider: string, modelId: string) =>
    provider === "openai-codex"
      ? hostCatalog.models.find((model) => model.id === modelId)
      : undefined,
  getBuiltinProviders: () => ["openai-codex"],
}));

import extension from "../src/index.js";
import { createCodexMultiProvider } from "../src/provider.js";
import type { CodexMultiOptions } from "../src/provider.js";

function piHarness() {
  const handlers: Record<string, any> = {};
  const events: Record<string, any> = {};
  return {
    handlers,
    events,
    pi: {
      registerProvider: vi.fn(),
      registerCommand: vi.fn((name: string, command: any) => {
        handlers[name] = command.handler;
      }),
      on: vi.fn((event: string, listener: any) => {
        events[event] = listener;
      }),
      setModel: vi.fn(),
    } as any,
  };
}

function minimalCtx() {
  return {
    mode: "tui",
    hasUI: false,
    modelRegistry: { getAll: vi.fn(() => []) },
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
      theme: { fg: (_token: string, value: string) => value },
    },
  } as any;
}

function registeredModelIds(registerProvider: ReturnType<typeof vi.fn>) {
  const registration = registerProvider.mock.calls.find(
    (call: any[]) => call[0] === "codex-multi",
  );
  expect(registration).toBeDefined();
  return registration![1].models.map((model: { id: string }) => model.id);
}

describe("startup Codex catalog", () => {
  it("registers the host-bundled gpt-6-sol at factory load, before any session_start", () => {
    const h = piHarness();

    extension(h.pi);

    // Pi resolves the initial model after extension factories run and before
    // session_start, so the pending registration must already carry the host
    // catalog at this point.
    expect(registeredModelIds(h.pi.registerProvider)).toContain("gpt-6-sol");
  });

  it.each(["startup", "reload", "new", "resume", "fork"] as const)(
    "never selects a model itself on %s",
    async (reason) => {
      const h = piHarness();
      extension(h.pi);

      await h.events.session_start({ type: "session_start", reason }, minimalCtx());

      expect(h.pi.setModel).not.toHaveBeenCalled();
    },
  );

  it("keeps the codex-multi provider name and host catalog through a session start", async () => {
    const h = piHarness();
    extension(h.pi);

    await h.events.session_start(
      { type: "session_start", reason: "startup" },
      minimalCtx(),
    );

    expect(registeredModelIds(h.pi.registerProvider)).toContain("gpt-6-sol");
    expect(h.pi.setModel).not.toHaveBeenCalled();
  });

  it("preserves explicit and runtime precedence over the host bundled catalog", () => {
    const runtimeModels = [{ ...hostCatalog.models[0], id: "runtime-only" }] as any;
    const explicitModels = [{ ...hostCatalog.models[0], id: "explicit-only" }] as any;

    const explicitRegister = vi.fn();
    createCodexMultiProvider({
      resolveAccount: vi.fn(),
      models: explicitModels,
      runtimeModels,
    } as CodexMultiOptions)({ registerProvider: explicitRegister } as never);
    expect(
      explicitRegister.mock.calls[0][1].models.map((model: { id: string }) => model.id),
    ).toEqual(["explicit-only"]);

    const runtimeRegister = vi.fn();
    createCodexMultiProvider({
      resolveAccount: vi.fn(),
      runtimeModels,
    } as CodexMultiOptions)({ registerProvider: runtimeRegister } as never);
    expect(
      runtimeRegister.mock.calls[0][1].models.map((model: { id: string }) => model.id),
    ).toEqual(["runtime-only"]);
  });

  it("falls back to the host bundled catalog containing gpt-6-sol", () => {
    const registerProvider = vi.fn();

    createCodexMultiProvider({ resolveAccount: vi.fn() } as CodexMultiOptions)({
      registerProvider,
    } as never);

    expect(
      registerProvider.mock.calls[0][1].models.map((model: { id: string }) => model.id),
    ).toEqual(hostCatalog.modelIds);
  });
});
