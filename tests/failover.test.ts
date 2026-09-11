import { describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountStore, StoreCommitUncertainError, type Account } from "../src/accounts/store.js";
import { createCodexMultiProvider, retryAfter, type CodexAccount } from "../src/provider.js";
    import { createAccountResolver } from "../src/accounts/selector.js";
import { TokenManager, TokenManagerError } from "../src/auth/token-manager.js";
function jwt(claims: object) { const part = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"); return `${part}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${part}`; }

async function setup(streamResponses: any, resolveAccount: any, options: any = {}) {
  const registerProvider = vi.fn();
  createCodexMultiProvider({ streamResponses, resolveAccount, ...options })({ registerProvider } as never);
  const definition = registerProvider.mock.calls[0][1];
  return definition.streamSimple(definition.models[0], { messages: [] }, options.requestOptions ?? {});
}
const account = (key: string): CodexAccount => ({ accountKey: key, accountId: `acct-${key}`, accessToken: `token-${key}`, refreshToken: `refresh-${key}` });

const storedAccount = (key: string, overrides: Partial<Account> = {}): Account => ({
  alias: key, id: key, accessToken: `token-${key}`, refreshToken: `refresh-${key}`, accountId: `acct-${key}`,
  expiresAt: 9_999_999_999, enabled: true, usageCount: 0, lastUsed: null, rateLimitedUntil: null, authInvalidAt: null, ...overrides,
});
async function healthStore(accounts: Account[]) {
  const path = join(await mkdtemp(join(tmpdir(), "pi-multi-auth-failover-")), "accounts.json");
  const store = new AccountStore({ path });
  await store.mutate(current => ({ ...current, accounts }));
  return store;
}
async function eventsOf(stream: AsyncIterable<any>) { const events: any[] = []; for await (const event of stream) events.push(event); return events; }
function deferred<T>() { let resolve!: (value: T | PromiseLike<T>) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function settlesPromptly<T>(promise: Promise<T>, label: string) { return Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} did not settle promptly`)), 100))]); }
function expectAborted(events: any[]) { expect(events).toHaveLength(1); expect(events[0]).toMatchObject({ type: "error", reason: "aborted" }); }

describe("provider account failover", () => {
  it("fails over on an HTTP-200 terminal usage-limit error before substantive output", async () => {
    const store = await healthStore([storedAccount("a"), storedAccount("b")]);
    const a = account("a"); const b = account("b"); const attempts: string[] = []; const sleep = vi.fn().mockResolvedValue(undefined);
    const resolve = vi.fn().mockImplementation((_signal: unknown, _model: unknown, excluded?: Set<string>) => excluded?.has("a") ? b : a);
    const transport = vi.fn().mockImplementation(async function* (_model: unknown, _context: unknown, options: any) {
      attempts.push(options.apiKey);
      const first = attempts.length === 1;
      await options.onResponse({ status: 400, headers: {} }, {});
      if (first) { yield { type: "error", reason: "error", error: { errorMessage: "Codex error: The usage limit has been reached" } }; return; }
      yield { type: "start", partial: {} }; yield { type: "text_delta", contentIndex: 0, delta: "ok", partial: { type: "text", text: "ok" } }; yield { type: "done", reason: "stop", message: {} };
    });
    const events = await eventsOf(await setup(transport, resolve, { store, now: () => 5_000, sleep }));
    expect((await store.load()).accounts.find(x => x.id === "a")?.rateLimitedUntilByModel?.["gpt-5.3-codex-spark"]).toBe(10_000);
    expect(sleep).toHaveBeenCalledOnce(); expect(sleep).toHaveBeenCalledWith(5_000, undefined);
    expect(attempts).toEqual([a.accessToken, b.accessToken]); expect(transport).toHaveBeenCalledTimes(2);
    expect(events.map(e => e.type)).toEqual(["start", "text_delta", "done"]);
    expect(JSON.stringify(events)).not.toContain("Codex error: The usage limit has been reached");
  });

  it("tries each account once on a pre-content 429 and preserves the caller callback", async () => {
    const a = account("a"); const b = account("b");
    const resolve = vi.fn().mockImplementation((_signal: unknown, _model: unknown, excluded?: Set<string>) => excluded?.has("a") ? b : a);
    const callback = vi.fn(); const attempts: string[] = [];
    const streamResponses = vi.fn().mockImplementation(async function* (_model: unknown, _context: unknown, options: any) {
      attempts.push(options.apiKey);
      await options.onResponse({ status: attempts.length === 1 ? 429 : 200, headers: { "retry-after": "0" } }, {});
      if (attempts.length === 1) { yield { type: "start", partial: {} }; yield { type: "error", reason: "error", error: {} }; return; }
      yield { type: "start", partial: {} }; yield { type: "text_delta", contentIndex: 0, delta: "ok", partial: {} }; yield { type: "done", reason: "stop", message: {} };
    });
    const stream = await setup(streamResponses, resolve, { sleep: async () => undefined, requestOptions: { onResponse: callback } });
    const events: any[] = [];
    for await (const event of stream) events.push(event);
    expect(attempts).toEqual([a.accessToken, b.accessToken]);
    expect(events.map(e => e.type)).toEqual(["start", "text_delta", "done"]);
    expect(streamResponses.mock.calls[0][2].maxRetries).toBe(0);
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it("does not retry after substantive output", async () => {
    const resolve = vi.fn().mockResolvedValue(account("a"));
    const streamResponses = vi.fn().mockImplementation(async function* (_m: unknown, _c: unknown, options: any) {
      await options.onResponse({ status: 429, headers: {} }, {});
      yield { type: "start", partial: {} }; yield { type: "thinking_delta", contentIndex: 0, delta: "x", partial: {} }; yield { type: "error", reason: "error", error: {} };
    
    });
    const stream = await setup(streamResponses, resolve, { sleep: async () => undefined });
    const events: any[] = []; for await (const event of stream) events.push(event);
    expect(resolve).toHaveBeenCalledOnce();
    expect(events.map(e => e.type)).toEqual(["start", "thinking_delta", "error"]);
  });

  it.each([["text_delta", { type: "text_delta", contentIndex: 0, delta: "x", partial: { type: "text", text: "x" } }], ["redacted thinking", { type: "thinking_start", contentIndex: 0, thinking: "[REDACTED]", partial: { type: "thinking", thinking: "[REDACTED]" } }], ["ordinary thinking", { type: "thinking_start", contentIndex: 0, partial: { type: "thinking", thinking: "" } }], ["tool call", { type: "toolcall_start", contentIndex: 0, id: "call-1", name: "lookup", arguments: { query: "status" }, partial: { type: "toolCall", id: "call-1", name: "lookup", arguments: { query: "status" } } }]])("A: substantive %s prevents failover", async (_label, event) => {
    const store = await healthStore([storedAccount("a")]); const before = await store.load(); const resolve = vi.fn().mockResolvedValue(account("a")); const sleep = vi.fn();
    const transport = vi.fn().mockImplementation(async function* (_m: unknown, _c: unknown, o: any) { await o.onResponse({ status: 401, headers: {} }, {}); yield event; yield { type: "error", reason: "error", error: { errorMessage: "provider body" } }; });
    const events = await eventsOf(await setup(transport, resolve, { store, sleep })); expect(resolve).toHaveBeenCalledOnce(); expect(transport).toHaveBeenCalledOnce(); expect(sleep).not.toHaveBeenCalled(); expect(await store.load()).toEqual(before); expect(events.map(e => e.type)).toEqual([event.type, "error"]);
  });

  it.each([[400, "bad request"], [500, "server error"], [503, "unavailable"]])("I: HTTP %s is terminal without health work", async (status, message) => {
    const resolve = vi.fn().mockResolvedValue(account("a")); const sleep = vi.fn(); const store = { mutate: vi.fn() }; const terminal = { type: "error", reason: "error", error: { errorMessage: message } };
    const transport = vi.fn().mockImplementation(async function* (_m: unknown, _c: unknown, o: any) { await o.onResponse({ status, headers: {} }, {}); yield terminal; }); const events = await eventsOf(await setup(transport, resolve, { store: store as never, sleep }));
    expect(resolve).toHaveBeenCalledOnce(); expect(transport).toHaveBeenCalledOnce(); expect(store.mutate).not.toHaveBeenCalled(); expect(sleep).not.toHaveBeenCalled(); expect(events).toEqual([terminal]);
  });

  it.each(["network throw", "context overflow", "tool/schema", "arbitrary terminal"])("I: %s emits exactly one safe or faithful terminal", async (kind) => {
    const resolve = vi.fn().mockResolvedValue(account("a")); const sleep = vi.fn(); const store = { mutate: vi.fn() }; const transport = vi.fn().mockImplementation(async function* (_m: unknown, _c: unknown, o: any) { if (kind === "network throw") throw new Error("raw provider body https://secret.invalid token=raw"); await o.onResponse({ status: 200, headers: {} }, {}); yield { type: "error", reason: "error", error: { errorMessage: kind } }; });
    const events = await eventsOf(await setup(transport, resolve, { store: store as never, sleep })); expect(resolve).toHaveBeenCalledOnce(); expect(transport).toHaveBeenCalledOnce(); expect(store.mutate).not.toHaveBeenCalled(); expect(sleep).not.toHaveBeenCalled(); expect(events).toHaveLength(1); expect(events[0].type).toBe("error"); expect(events[0].error.errorMessage).toBe(kind === "network throw" ? "codex-multi request failed" : kind);
  });

  it.each([401, 429])("J: uncertain health commit on %s is terminal and never retried", async (status) => {
    const resolve = vi.fn().mockResolvedValue(account("a")); const sleep = vi.fn(); const store = { mutate: vi.fn().mockRejectedValue(new StoreCommitUncertainError()) }; const transport = vi.fn().mockImplementation(async function* (_m: unknown, _c: unknown, o: any) { await o.onResponse({ status, headers: { "retry-after": "0" } }, {}); yield { type: "start", partial: {} }; yield { type: "error", reason: "error", error: { errorMessage: "raw provider body" } }; });
    const events = await eventsOf(await setup(transport, resolve, { store: store as never, sleep })); const serialized = JSON.stringify(events); expect(events).toHaveLength(1); expect(events[0].error.errorMessage).toBe("codex-multi account health update is uncertain; request was not retried"); expect(resolve).toHaveBeenCalledOnce(); expect(transport).toHaveBeenCalledOnce(); expect(sleep).not.toHaveBeenCalled(); expect(serialized).not.toMatch(/raw provider body|acct-a|https?:\/\//i);
  });

  it.each([["two", ["a", "b"]], ["three", ["a", "b", "c"]]])("K: %s accounts exhaust in order without leakage", async (_label, keys) => {
    const accounts = keys.map(account); const resolve = vi.fn().mockImplementation((_s: unknown, _m: unknown, excluded?: Set<string>) => accounts.find(a => !excluded?.has(a.accountKey!))); const transport = vi.fn().mockImplementation(async function* (_m: unknown, _c: unknown, o: any) { await o.onResponse({ status: 429, headers: { "retry-after": "0" } }, {}); yield { type: "start", partial: {} }; yield { type: "error", reason: "error", error: { errorMessage: "provider body" } }; });
    const events = await eventsOf(await setup(transport, resolve, { sleep: async () => undefined })); const serialized = JSON.stringify(events); expect(resolve).toHaveBeenCalledTimes(keys.length + 1); expect(transport).toHaveBeenCalledTimes(keys.length); expect(events.map(e => e.type)).toEqual(["error"]); expect(events[0].error.errorMessage).toBe(`codex-multi exhausted ${keys.length} account attempts (${Array(keys.length).fill("rate-limited").join(",")})`); for (const secret of ["acct-", "token-", "refresh-", "provider body", "https://", "Error"]) expect(serialized).not.toContain(secret);
  });

  it("L: explicit callback runs once per physical attempt before each attempt's events", async () => {
    const a = account("a"); const b = account("b"); const order: string[] = []; const callback = vi.fn(async (response: any, model: any) => { order.push(`callback:${response.status}:${model.attempt}`); }); const resolve = vi.fn().mockImplementation((_s: unknown, _m: unknown, excluded?: Set<string>) => excluded?.has("a") ? b : a);
    const transport = vi.fn().mockImplementation(async function* (_m: unknown, _c: unknown, o: any) { const attempt = transport.mock.calls.length; await o.onResponse({ status: attempt === 1 ? 429 : 200, headers: { "retry-after": "0" } }, { attempt }); order.push(`start:${attempt}`); yield { type: "start", partial: {} }; if (attempt === 1) { order.push(`error:${attempt}`); yield { type: "error", reason: "error", error: {} }; } else { order.push(`done:${attempt}`); yield { type: "done", reason: "stop", message: {} }; } });
    const events = await eventsOf(await setup(transport, resolve, { sleep: async () => undefined, requestOptions: { onResponse: callback } })); expect(callback).toHaveBeenCalledTimes(2); expect(callback.mock.calls.map(([response, model]) => [response.status, model.attempt])).toEqual([[429, 1], [200, 2]]); expect(order).toEqual(["callback:429:1", "start:1", "error:1", "callback:200:2", "start:2", "done:2"]); expect(events.map(e => e.type)).toEqual(["start", "done"]);
  });

  it("L: callback rejection is terminal before health or retry", async () => {
    const callback = vi.fn().mockRejectedValue(new Error("rejected")); const store = { mutate: vi.fn() }; const sleep = vi.fn(); const resolve = vi.fn().mockResolvedValue(account("a")); const transport = vi.fn().mockImplementation(async function* (_m: unknown, _c: unknown, o: any) { await o.onResponse({ status: 429, headers: { "retry-after": "0" } }, {}); yield { type: "start", partial: {} }; });
    const events = await eventsOf(await setup(transport, resolve, { store: store as never, sleep, requestOptions: { onResponse: callback } })); expect(callback).toHaveBeenCalledOnce(); expect(resolve).toHaveBeenCalledOnce(); expect(transport).toHaveBeenCalledOnce(); expect(store.mutate).not.toHaveBeenCalled(); expect(sleep).not.toHaveBeenCalled(); expect(events).toHaveLength(1); expect(events[0].error.errorMessage).toBe("codex-multi request failed");
  });

  it.each([["integer", "7", 7_000], ["date", "Thu, 01 Jan 1970 00:00:12 GMT", 7_000], ["missing", undefined, 5_000], ["invalid", "nonsense", 5_000], ["below-min", "0", 1_000], ["above-max", "999", 60_000]])("1: Retry-After %s uses conservative deadline", async (_label, retry, delay) => {
    const store = await healthStore([storedAccount("a", { rateLimitedUntil: null })]);
    const transport = vi.fn().mockImplementation(async function* (_m: unknown, _c: unknown, o: any) { await o.onResponse({ status: 429, headers: retry === undefined ? {} : { "retry-after": retry } }, {}); yield { type: "start", partial: {} }; yield { type: "error", reason: "error", error: {} }; });
    await eventsOf(await setup(transport, vi.fn().mockResolvedValue(account("a")), { store, now: () => 5_000, sleep: async () => undefined }));
    expect((await store.load()).accounts[0].rateLimitedUntilByModel?.["gpt-5.3-codex-spark"]).toBe(5_000 + delay);
  });

  it.each([401, 403])("2: CAS-invalidates observed credentials on %s only", async (status) => {
    const store = await healthStore([storedAccount("a")]);
    const transport = vi.fn().mockImplementation(async function* (_m: unknown, _c: unknown, o: any) { await o.onResponse({ status, headers: {} }, {}); yield { type: "start", partial: {} }; yield { type: "error", reason: "error", error: {} }; });
    await eventsOf(await setup(transport, vi.fn().mockResolvedValue(account("a")), { store, now: () => 1234, sleep: async () => undefined }));
    expect((await store.load()).accounts[0].authInvalidAt).toBe(1234);
    await store.mutate(s => ({ ...s, accounts: s.accounts.map(a => ({ ...a, accessToken: "new-access", authInvalidAt: null })) }));
    await eventsOf(await setup(transport, vi.fn().mockResolvedValue(account("a")), { store, now: () => 2000, sleep: async () => undefined }));
    expect((await store.load()).accounts[0].authInvalidAt).toBeNull();
  });

  it.each([[401, "access"], [401, "refresh"], [401, "both"], [403, "access"], [403, "refresh"], [403, "both"]] as const)("G: stale %s response after %s mutation never invalidates newer credentials or escapes bounded failover", async (status, mutation) => {
        const store = await healthStore([storedAccount("a"), storedAccount("b")]);
        const resolver = createAccountResolver(store);
        const changed = deferred<void>();
        const attempts: string[] = [];
        const transport = vi.fn().mockImplementation(async function* (_m: unknown, _c: unknown, o: any) {
          attempts.push(o.apiKey);
          if (attempts.length === 1) {
            await o.onResponse({ status, headers: {} }, {});
            await changed.promise;
            yield { type: "start", partial: {} };
            yield { type: "error", reason: "error", error: {} };
            return;
          }
          await o.onResponse({ status: 200, headers: {} }, {});
          yield { type: "start", partial: {} };
          yield { type: "done", reason: "stop", message: {} };
        });
        const stream = await setup(transport, resolver, { store, now: () => 1234, sleep: async () => undefined });
        const pending = eventsOf(stream);
        await vi.waitFor(async () => expect((await store.load()).accounts[0].usageCount).toBe(1));
        await store.mutate(current => ({ ...current, accounts: current.accounts.map(a => a.id === "a" ? { ...a, accessToken: mutation === "refresh" ? a.accessToken : "new-access", refreshToken: mutation === "access" ? a.refreshToken : "new-refresh" } : a) }));
        changed.resolve();
        const events = await pending;
        expect(events.map(e => e.type)).toEqual(["start", "done"]);
        expect(attempts).toEqual(["token-a", "token-b"]);
        const after = await store.load();
        const winner = after.accounts.find(a => a.id === "a")!;
        expect(winner).toMatchObject({ id: "a", accessToken: mutation === "refresh" ? "token-a" : "new-access", refreshToken: mutation === "access" ? "refresh-a" : "new-refresh", authInvalidAt: null });
        expect(after.accounts.find(a => a.id === "b")?.usageCount).toBe(1);
      });

      it.each([401, 403])("G: matching snapshot marks auth invalid exactly once on %s", async (status) => {
        const store = await healthStore([storedAccount("a")]);
        const mutate = vi.spyOn(store, "mutate");
        const transport = vi.fn().mockImplementation(async function* (_m: unknown, _c: unknown, o: any) { await o.onResponse({ status, headers: {} }, {}); yield { type: "start", partial: {} }; yield { type: "error", reason: "error", error: {} }; });
        await eventsOf(await setup(transport, createAccountResolver(store), { store, now: () => 1234, sleep: async () => undefined }));
        expect(mutate).toHaveBeenCalledTimes(3);
        await expect(store.load()).resolves.toMatchObject({ accounts: [{ id: "a", accessToken: "token-a", refreshToken: "refresh-a", authInvalidAt: 1234 }] });
      });

      it("3/4: invokes caller response per attempt and preserves request options", async () => {
    const a = account("a"); const b = account("b"); const seen: any[] = []; const callback = vi.fn();
    const resolve = vi.fn().mockImplementation((_s: unknown, _m: unknown, excluded?: Set<string>) => excluded?.has("a") ? b : a);
    const transport = vi.fn().mockImplementation(async function* (_m: unknown, _c: unknown, o: any) { seen.push(o); await o.onResponse({ status: seen.length === 1 ? 429 : 200, headers: {} }, { attempt: seen.length }); yield { type: "start", partial: {} }; if (seen.length === 1) yield { type: "error", reason: "error", error: {} }; else yield { type: "done", reason: "stop", message: {} }; });
    const original = { maxRetries: 8, headers: { "X-Test": "kept" }, onResponse: callback };
    const register = vi.fn(); createCodexMultiProvider({ resolveAccount: resolve, streamResponses: transport, sleep: async () => undefined })({ registerProvider: register } as never); const d = register.mock.calls[0][1]; await eventsOf(d.streamSimple(d.models[0], { messages: [] }, original));
    expect(callback).toHaveBeenCalledTimes(2); expect(seen.map(o => o.maxRetries)).toEqual([0, 0]); expect(original).toEqual({ maxRetries: 8, headers: { "X-Test": "kept" }, onResponse: callback }); expect(seen[0].headers.Authorization).toContain(a.accessToken); expect(seen[1].headers.Authorization).toContain(b.accessToken);
  });

  it("3: caller rejection is non-retry and yields one safe terminal event", async () => {
    const callback = vi.fn().mockRejectedValue(new Error("caller rejected")); const resolve = vi.fn().mockResolvedValue(account("a"));
    const transport = vi.fn().mockImplementation(async function* (_m: unknown, _c: unknown, o: any) { await o.onResponse({ status: 200, headers: {} }, {}); yield { type: "start", partial: {} }; yield { type: "error", reason: "error", error: {} }; });
    const register = vi.fn(); createCodexMultiProvider({ resolveAccount: resolve, streamResponses: transport })({ registerProvider: register } as never); const d = register.mock.calls[0][1]; const events = await eventsOf(d.streamSimple(d.models[0], { messages: [] }, { onResponse: callback }));
    expect(callback).toHaveBeenCalledOnce(); expect(transport).toHaveBeenCalledOnce(); expect(events.filter(e => e.type === "error")).toHaveLength(1); expect(events[0].error.errorMessage).toBe("codex-multi request failed");
  });

  it.each(["TOKEN_REFRESH_INVALID", "TOKEN_REFRESH_FAILED", "TOKEN_REFRESH_CONFLICT"])("6: %s refresh classification fails over", async (code) => {
    const a = account("a"); const b = account("b"); const resolve = vi.fn().mockImplementation((_s: unknown, _m: unknown, excluded?: Set<string>) => excluded?.has("a") ? b : (() => { throw new TokenManagerError(code as any, "safe", "a"); })());
    const transport = vi.fn().mockImplementation(async function* (_m: unknown, _c: unknown, o: any) { await o.onResponse({ status: 200, headers: {} }, {}); yield { type: "start", partial: {} }; yield { type: "done", reason: "stop", message: {} }; });
    const events = await eventsOf(await setup(transport, resolve)); expect(resolve).toHaveBeenCalledTimes(2); expect(transport).toHaveBeenCalledOnce(); expect(events.map(e => e.type)).toEqual(["start", "done"]);
  });

  it("5/7/8: exhausts accounts once and preserves streaming integrity", async () => {
    const accounts = [account("a"), account("b"), account("c")]; const resolve = vi.fn().mockImplementation((_s: unknown, _m: unknown, excluded?: Set<string>) => accounts.find(a => !excluded?.has(a.accountKey!)));
    const transport = vi.fn().mockImplementation(async function* (_m: unknown, _c: unknown, o: any) { await o.onResponse({ status: 429, headers: { "retry-after": "0" } }, {}); yield { type: "start", partial: {} }; yield { type: "error", reason: "error", error: {} }; });
    const events = await eventsOf(await setup(transport, resolve, { sleep: async () => undefined })); expect(transport).toHaveBeenCalledTimes(3); expect(events.filter(e => e.type === "error")).toHaveLength(1); expect(events.at(-1).error.errorMessage).toMatch(/3 account attempts/);
  });

  it("9/10/12: concurrent streams have independent exclusions and completed streams need no cancellation", async () => {
    const controller = new AbortController(); const accounts = [account("a"), account("b")]; const calls: string[] = [];
    const resolve = vi.fn().mockImplementation((_s: unknown, _m: unknown, excluded?: Set<string>) => accounts.find(a => !excluded?.has(a.accountKey!)));
    const transport = vi.fn().mockImplementation(async function* (_m: unknown, _c: unknown, o: any) { calls.push(o.apiKey); await o.onResponse({ status: 200, headers: {} }, {}); yield { type: "start", partial: {} }; yield { type: "done", reason: "stop", message: {} }; });
    const register = vi.fn(); createCodexMultiProvider({ resolveAccount: resolve, streamResponses: transport })({ registerProvider: register } as never); const d = register.mock.calls[0][1]; await Promise.all([eventsOf(d.streamSimple(d.models[0], { messages: [] }, {})), eventsOf(d.streamSimple(d.models[0], { messages: [] }, { signal: controller.signal }))]);
    expect(calls).toHaveLength(2); expect(resolve).toHaveBeenCalledTimes(2); controller.abort(); expect(transport).toHaveBeenCalledTimes(2);
  });

  it("B1: aborts a pending onResponse callback without waiting for iterator.return", async () => {
    const controller = new AbortController(); const callbackGate = deferred<void>(); const nextGate = deferred<IteratorResult<any>>(); const returnGate = deferred<IteratorResult<any>>();
    let responsePromise!: Promise<void>; const iterator = { next: vi.fn(async () => { await responsePromise; return nextGate.promise; }), return: vi.fn(() => returnGate.promise) }; const callback = vi.fn(() => callbackGate.promise);
    const transport = vi.fn((_: unknown, __: unknown, options: any) => { responsePromise = options.onResponse({ status: 200, headers: {} }, {}); return { [Symbol.asyncIterator]: () => iterator }; });
    const stream = await setup(transport, vi.fn().mockResolvedValue(account("a")), { requestOptions: { signal: controller.signal, onResponse: callback } }); const result = eventsOf(stream); await vi.waitFor(() => expect(callback).toHaveBeenCalledOnce()); controller.abort(); expectAborted(await settlesPromptly(result, "pending onResponse")); expect(iterator.return).toHaveBeenCalledOnce(); callbackGate.resolve(); nextGate.resolve({ done: true, value: undefined }); returnGate.resolve({ done: true, value: undefined });
  });

  it("B2: aborts a pending iterator.next and suppresses later content", async () => {
    const controller = new AbortController(); const nextGate = deferred<IteratorResult<any>>(); const returnGate = deferred<IteratorResult<any>>(); const iterator = { next: vi.fn(() => nextGate.promise), return: vi.fn(() => returnGate.promise) };
    const stream = await setup(() => ({ [Symbol.asyncIterator]: () => iterator }), vi.fn().mockResolvedValue(account("a")), { requestOptions: { signal: controller.signal } }); const result = eventsOf(stream); await vi.waitFor(() => expect(iterator.next).toHaveBeenCalledOnce()); controller.abort(); expectAborted(await settlesPromptly(result, "pending iterator.next")); expect(iterator.return).toHaveBeenCalledOnce(); nextGate.resolve({ done: false, value: { type: "text_delta", delta: "late" } }); returnGate.resolve({ done: true, value: undefined });
  });

  it("B3: aborts while a narrow fake store health mutation is pending", async () => {
    const controller = new AbortController(); const gate = deferred<void>(); const returnGate = deferred<IteratorResult<any>>(); const store = { mutate: vi.fn(async (mutation: any) => { mutation({ version: 2, accounts: [] }); await gate.promise; return { version: 2, accounts: [] }; }) };
    const iterator = { next: vi.fn().mockResolvedValueOnce({ done: false, value: { type: "start", partial: {} } }).mockResolvedValueOnce({ done: false, value: { type: "error", reason: "error", error: {} } }).mockResolvedValueOnce({ done: true, value: undefined }), return: vi.fn(() => returnGate.promise) }; const transport = vi.fn(async (_: unknown, __: unknown, options: any) => { await options.onResponse({ status: 429, headers: { "retry-after": "0" } }, {}); return { [Symbol.asyncIterator]: () => iterator }; }); const resolve = vi.fn().mockResolvedValue(account("a"));
    const stream = await setup(transport, resolve, { store: store as never, sleep: async () => undefined, requestOptions: { signal: controller.signal } }); const result = eventsOf(stream); await vi.waitFor(() => expect(store.mutate).toHaveBeenCalledOnce()); controller.abort(); expectAborted(await settlesPromptly(result, "health mutation")); expect(resolve).toHaveBeenCalledOnce(); expect(transport).toHaveBeenCalledOnce(); expect(iterator.return).toHaveBeenCalledOnce(); gate.resolve(); returnGate.resolve({ done: true, value: undefined });
  });

  it("B4: aborts during injected non-cancellable sleep without resolving another account", async () => {
    const controller = new AbortController(); const sleepGate = deferred<void>(); const returnGate = deferred<IteratorResult<any>>(); const iterator = { next: vi.fn().mockResolvedValueOnce({ done: false, value: { type: "start", partial: {} } }).mockResolvedValueOnce({ done: false, value: { type: "error", reason: "error", error: {} } }).mockResolvedValueOnce({ done: true, value: undefined }), return: vi.fn(() => returnGate.promise) }; const sleep = vi.fn(() => sleepGate.promise); const resolve = vi.fn().mockResolvedValue(account("a"));
    const stream = await setup(async (_m: unknown, _c: unknown, options: any) => { await options.onResponse({ status: 429, headers: { "retry-after": "0" } }, {}); return { [Symbol.asyncIterator]: () => iterator }; }, resolve, { sleep, requestOptions: { signal: controller.signal } }); const result = eventsOf(stream); await vi.waitFor(() => expect(sleep).toHaveBeenCalledOnce()); controller.abort(); expectAborted(await settlesPromptly(result, "sleep")); expect(resolve).toHaveBeenCalledOnce(); expect(iterator.return).toHaveBeenCalledOnce(); returnGate.resolve({ done: true, value: undefined });
  });

  it("B4b: default sleep clears its timer and abort listener on abort", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController(); let active = 0;
      const signal = { get aborted() { return controller.signal.aborted; }, addEventListener(type: string, listener: EventListener, options?: AddEventListenerOptions) { if (type === "abort") active++; controller.signal.addEventListener(type, listener, options); }, removeEventListener(type: string, listener: EventListener) { if (type === "abort") active--; controller.signal.removeEventListener(type, listener); } } as unknown as AbortSignal;
      const iterator = { next: vi.fn().mockResolvedValueOnce({ done: false, value: { type: "start", partial: {} } }).mockResolvedValueOnce({ done: false, value: { type: "error", reason: "error", error: {} } }), return: vi.fn().mockResolvedValue({ done: true, value: undefined }) };
      const transport = vi.fn(async (_m: unknown, _c: unknown, options: any) => { await options.onResponse({ status: 429, headers: { "retry-after": "60" } }, {}); return { [Symbol.asyncIterator]: () => iterator }; });
      const stream = await setup(transport, vi.fn().mockResolvedValue(account("a")), { requestOptions: { signal } });
      const result = eventsOf(stream);
      await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0));
      controller.abort();
      expectAborted(await result);
      expect(vi.getTimerCount()).toBe(0);
      expect(active).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("B5: aborts immediately before resolving the next account", async () => {
    const controller = new AbortController(); const sleepGate = deferred<void>(); const returnGate = deferred<IteratorResult<any>>(); const a = account("a"); const b = account("b"); const iterator = { next: vi.fn().mockResolvedValueOnce({ done: false, value: { type: "start", partial: {} } }).mockResolvedValueOnce({ done: false, value: { type: "error", reason: "error", error: {} } }).mockResolvedValueOnce({ done: true, value: undefined }), return: vi.fn(() => returnGate.promise) }; const resolve = vi.fn().mockImplementation((_s: unknown, _m: unknown, excluded?: Set<string>) => excluded?.has("a") ? b : a);
    const sleep = vi.fn(() => sleepGate.promise); const stream = await setup(async (_m: unknown, _c: unknown, options: any) => { await options.onResponse({ status: 429, headers: { "retry-after": "0" } }, {}); return { [Symbol.asyncIterator]: () => iterator }; }, resolve, { sleep, requestOptions: { signal: controller.signal } }); const result = eventsOf(stream); await vi.waitFor(() => expect(sleep).toHaveBeenCalledOnce()); controller.abort(); sleepGate.resolve(); expectAborted(await settlesPromptly(result, "next-account boundary")); expect(resolve).toHaveBeenCalledOnce(); await vi.waitFor(() => expect(iterator.return).toHaveBeenCalledOnce()); returnGate.resolve({ done: true, value: undefined });
  });

  it.each([["seconds", { "Retry-After": "7" }, 7_000], ["HTTP date", { "retry-after": "Thu, 01 Jan 1970 00:00:12 GMT" }, 7_000], ["missing", {}, 5_000], ["invalid", { "RETRY-AFTER": "nonsense" }, 5_000], ["below-min", { "retry-after": "0.1" }, 1_000], ["zero", { "retry-after": "0" }, 1_000], ["negative", { "retry-after": "-2" }, 1_000], ["above-max", { "retry-after": "999" }, 60_000]])("F: Retry-After %s directly sets a fresh account deadline", async (_label, headers, delay) => {
            const store = await healthStore([storedAccount("fresh", { rateLimitedUntil: null })]); const transport = vi.fn().mockImplementation(async function* (_m: unknown, _c: unknown, o: any) { await o.onResponse({ status: 429, headers }, {}); yield { type: "start", partial: {} }; yield { type: "error", reason: "error", error: {} }; }); await eventsOf(await setup(transport, vi.fn().mockResolvedValue(account("fresh")), { store, now: () => 5_000, sleep: async () => undefined })); expect((await store.load()).accounts[0].rateLimitedUntilByModel?.["gpt-5.3-codex-spark"]).toBe(5_000 + delay);
          });
      it("F: fractional numeric policy is seconds with millisecond precision", () => { expect(retryAfter({ "retry-after": "1.25" }, 5_000)).toBe(1_250); });

      it("F: preserves a later deadline and extends an earlier deadline", async () => {
        const run = async (existing: number | null) => { const store = await healthStore([storedAccount("fresh", { rateLimitedUntil: existing })]); const transport = vi.fn().mockImplementation(async function* (_m: unknown, _c: unknown, o: any) { await o.onResponse({ status: 429, headers: { "retry-after": "7" } }, {}); yield { type: "start", partial: {} }; yield { type: "error", reason: "error", error: {} }; }); await eventsOf(await setup(transport, vi.fn().mockResolvedValue(account("fresh")), { store, now: () => 5_000, sleep: async () => undefined })); return (await store.load()).accounts[0].rateLimitedUntilByModel?.["gpt-5.3-codex-spark"]; };
        await expect(run(20_000)).resolves.toBe(20_000); await expect(run(1_000)).resolves.toBe(12_000);
      });

      it("H: concurrent store-backed streams isolate reservations, headers, and abort", async () => {
        const store = await healthStore([storedAccount("a", { accessToken: jwt({ account_id: "acct-a", exp: 4_000_000_000 }), expiresAt: 9_999_999_999_999 }), storedAccount("b", { accessToken: jwt({ account_id: "acct-b", exp: 4_000_000_000 }), expiresAt: 9_999_999_999_999 }), storedAccount("c", { accessToken: jwt({ account_id: "acct-c", exp: 4_000_000_000 }), expiresAt: 9_999_999_999_999 })]);
        const manager = new TokenManager(store, { now: () => 1_700_000_000_000 }); const exclusions: string[][] = []; const resolve = (signal?: AbortSignal, model?: string, excluded?: ReadonlySet<string>) => { exclusions.push([...excluded ?? []]); return manager.prepare(signal, model, { excludeAccountKeys: excluded }); };
        const firstA = deferred<void>(); const firstB = deferred<void>(); const abortA = new AbortController(); const attempts: any[] = [];
        const transport = vi.fn().mockImplementation(async function* (_m: unknown, _c: unknown, o: any) { const stream = o.headers["X-Stream"]; const key = o.headers["chatgpt-account-id"].replace("acct-", ""); attempts.push({ stream, key, authorization: o.headers.Authorization, account: o.headers["chatgpt-account-id"] }); if (attempts.filter(x => x.stream === stream).length === 1) { await (stream === "A" ? firstA.promise : firstB.promise); await o.onResponse({ status: 429, headers: { "retry-after": "0" } }, {}); yield { type: "start", partial: {} }; yield { type: "error", reason: "error", error: {} }; return; } await o.onResponse({ status: 200, headers: {} }, {}); yield { type: "start", partial: {} }; yield { type: "done", reason: "stop", message: {} }; });
        const register = vi.fn(); createCodexMultiProvider({ resolveAccount: resolve as any, streamResponses: transport, store, sleep: async () => undefined, now: () => 1_700_000_000_000 })({ registerProvider: register } as never); const d = register.mock.calls[0][1]; const oa = { signal: abortA.signal, headers: { "X-Stream": "A", "X-Caller": "kept" }, maxRetries: 9 }; const ob = { headers: { "X-Stream": "B", "X-Caller": "kept" }, maxRetries: 8 }; const ca = structuredClone(oa); const cb = structuredClone(ob);
        const pa = eventsOf(d.streamSimple(d.models[0], { messages: [] }, oa)); const pb = eventsOf(d.streamSimple(d.models[0], { messages: [] }, ob)); await vi.waitFor(() => expect(attempts).toHaveLength(2)); expect(new Set(attempts.map(x => x.key))).toEqual(new Set(["a", "b"])); firstB.resolve(); await vi.waitFor(() => expect(attempts.filter(x => x.stream === "B")).toHaveLength(2)); abortA.abort(); const [ea, eb] = await Promise.all([pa, pb]);
        expectAborted(ea); expect(eb.map(e => e.type)).toEqual(["start", "done"]); expect(attempts.filter(x => x.stream === "A")).toHaveLength(1); expect(attempts.filter(x => x.stream === "B")).toHaveLength(2); expect(attempts.filter(x => x.stream === "B")[1].key).toBe("c"); expect(exclusions).toContainEqual(["b"]); expect(exclusions).not.toContainEqual(expect.arrayContaining(["a", "b"])); expect(attempts.every(x => x.account === `acct-${x.key}` && x.authorization.startsWith("Bearer "))).toBe(true); expect(oa.headers).toEqual(ca.headers); expect(oa.maxRetries).toBe(ca.maxRetries); expect(ob).toEqual(cb);
        const final = await store.load(); expect(final.accounts.reduce((sum, x) => sum + x.usageCount, 0)).toBe(3); for (const key of ["a", "b", "c"]) expect(final.accounts.find(x => x.id === key)?.usageCount).toBe(attempts.filter(x => x.key === key).length);
      });

      it("C: removes every abort listener after eleven events and normal completion", async () => {
    const native = new AbortController(); let active = 0; let added = 0; let removed = 0; const signal = { get aborted() { return native.signal.aborted; }, addEventListener(type: string, listener: EventListener, options?: AddEventListenerOptions) { if (type === "abort") { active++; added++; native.signal.addEventListener(type, listener, options); } }, removeEventListener(type: string, listener: EventListener) { if (type === "abort") { active--; removed++; native.signal.removeEventListener(type, listener); } } } as unknown as AbortSignal;
    const events: any[] = Array.from({ length: 11 }, (_, i) => ({ type: "text_delta", delta: `${i}`, partial: {} })); events.push({ type: "done", reason: "stop", message: {} }); const transport = vi.fn(async function* (_: unknown, __: unknown, options: any) { await options.onResponse({ status: 200, headers: {} }, {}); yield* events; });
    expect((await eventsOf(await setup(transport, vi.fn().mockResolvedValue(account("a")), { requestOptions: { signal } }))).map(e => e.type)).toEqual([...Array(11).fill("text_delta"), "done"]); expect(added).toBe(removed); expect(active).toBe(0);
  });
});