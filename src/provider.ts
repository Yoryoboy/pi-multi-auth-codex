import { createAssistantMessageEventStream, openAICodexResponsesApi, type Api, type AssistantMessageEvent, type Model, type SimpleStreamOptions, type StreamFunction } from "@earendil-works/pi-ai/compat";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AccountStore, StoreCommitUncertainError } from "./accounts/store.js";
import { AccountSelectionError } from "./accounts/selector.js";
import { TokenManager, TokenManagerError } from "./auth/token-manager.js";

export const RATE_LIMIT_MIN_DELAY_MS = 1_000, RATE_LIMIT_MAX_DELAY_MS = 60_000, RATE_LIMIT_FALLBACK_DELAY_MS = 5_000, AUTH_INVALID_COOLDOWN_MS = 5 * 60_000;
export interface CodexAccount { accessToken: string; accountId: string; accountKey: string; refreshToken: string; }
export type AccountResolver = (signal?: AbortSignal, modelId?: string, excludeAccountKeys?: ReadonlySet<string>) => CodexAccount | undefined | Promise<CodexAccount | undefined>;
export type ResponsesStreamer = StreamFunction<Api, SimpleStreamOptions>;
export interface CodexMultiOptions { resolveAccount: AccountResolver; models?: readonly Model<Api>[]; streamResponses?: ResponsesStreamer; store?: AccountStore; sleep?: (ms: number, signal?: AbortSignal) => Promise<void>; now?: () => number; }

const DEFAULT_MODELS = openaiCodexProvider().getModels();
const DEFAULT_MODEL_ID = DEFAULT_MODELS[0]?.id ?? "gpt-5.6-sol";
function safeError(message: string, aborted = false, modelId = DEFAULT_MODEL_ID): AssistantMessageEvent { return { type: "error", reason: aborted ? "aborted" : "error", error: { role: "assistant", content: [], api: "openai-codex-responses", provider: "codex-multi", model: modelId, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: aborted ? "aborted" : "error", errorMessage: message, timestamp: Date.now() } } as AssistantMessageEvent; }
function cooldownDeadline(account: CodexAccount & { rateLimitedUntil?: number | null; rateLimitedUntilByModel?: Record<string, number> }, modelId: string, now: number, delay: number) {
  return Math.max(account.rateLimitedUntil ?? 0, account.rateLimitedUntilByModel?.[modelId] ?? 0, account.rateLimitedUntilByModel?.["*"] ?? 0, now + delay);
}
function aborted(signal?: AbortSignal, modelId = DEFAULT_MODEL_ID) { return signal?.aborted ? safeError("codex-multi request was aborted", true, modelId) : undefined; }
function abortError() { return new Error("Request was aborted"); }
/** Race an operation with cancellation and always detach the abort listener. */
function raceWithAbort<T>(operation: PromiseLike<T> | T, signal?: AbortSignal): Promise<T> {
  if (!signal) return Promise.resolve(operation);
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const resolveOnce = (value: T) => { if (settled) return; settled = true; cleanup(); resolve(value); };
    const rejectOnce = (error: unknown) => { if (settled) return; settled = true; cleanup(); reject(error); };
    const onAbort = () => rejectOnce(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(operation).then(resolveOnce, rejectOnce);
  });
}
function header(h: Record<string, string>, n: string) { const k = Object.keys(h).find(x => x.toLowerCase() === n.toLowerCase()); return k ? h[k] : undefined; }
export function retryAfter(h: Record<string, string>, now = Date.now()) { const v = header(h, "retry-after"); let d: number | undefined; if (v !== undefined && /^\s*[-+]?\d+(?:\.\d+)?\s*$/.test(v)) d = Number(v) * 1000; else if (v) { const t = Date.parse(v); if (!Number.isNaN(t)) d = t - now; } if (!Number.isFinite(d)) d = RATE_LIMIT_FALLBACK_DELAY_MS; return Math.min(RATE_LIMIT_MAX_DELAY_MS, Math.max(RATE_LIMIT_MIN_DELAY_MS, d as number)); }
function substantive(e: AssistantMessageEvent) { return ["text_delta", "text_end", "thinking_start", "thinking_delta", "thinking_end", "toolcall_start", "toolcall_delta", "toolcall_end"].includes(e.type); }
const USAGE_LIMIT_MESSAGE = "Codex error: The usage limit has been reached";
function isUsageLimitTerminal(e: AssistantMessageEvent | undefined, emitted: boolean) {
  return !emitted && e?.type === "error" && typeof e.error?.errorMessage === "string" && e.error.errorMessage.trim() === USAGE_LIMIT_MESSAGE;
}
function isAbort(e: unknown, s?: AbortSignal) { return !!s?.aborted || (e instanceof Error && (e.name === "AbortError" || e.message === "Request was aborted")); }
function retryRefresh(e: unknown) { return e instanceof TokenManagerError && ["TOKEN_REFRESH_INVALID", "TOKEN_REFRESH_FAILED", "TOKEN_REFRESH_CONFLICT"].includes(e.code); }
function valid(a: CodexAccount | undefined): a is CodexAccount { return !!a && [a.accountKey, a.refreshToken, a.accessToken, a.accountId].every(x => typeof x === "string" && x.trim().length > 0); }
async function health(store: AccountStore | undefined, signal: AbortSignal | undefined, key: string, access: string, refresh: string, fn: (a: any, n: number) => any, n: number) { if (signal?.aborted) throw abortError(); if (!store) return; await store.mutate(s => { if (signal?.aborted) throw abortError(); return { ...s, accounts: s.accounts.map(a => a.id === key && a.accessToken === access && a.refreshToken === refresh ? fn(a, n) : a) }; }); if (signal?.aborted) throw abortError(); }
async function defaultSleep(ms: number, signal?: AbortSignal) {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const resolveOnce = () => { if (settled) return; settled = true; cleanup(); resolve(); };
    const rejectOnce = (error: unknown) => { if (settled) return; settled = true; cleanup(); reject(error); };
    const onAbort = () => rejectOnce(abortError());
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(resolveOnce, ms);
  });
}

export function createCodexMultiProvider(options: CodexMultiOptions) {
  const models = (options.models ?? DEFAULT_MODELS).map(model => ({ ...model, provider: "codex-multi" })) as Model<"openai-codex-responses">[];
  const transport = options.streamResponses ?? openAICodexResponsesApi().streamSimple, sleep = options.sleep ?? defaultSleep, now = options.now ?? Date.now;
  const streamSimple: StreamFunction<"openai-codex-responses", SimpleStreamOptions> = (model, context, ro) => {
    const out = createAssistantMessageEventStream();
    void (async () => {
      const tried = new Set<string>(), cats: string[] = []; let ended = false;
      const end = (e?: AssistantMessageEvent) => { if (ended) return; ended = true; if (e) out.push(e); out.end(); };
      try {
        for (let n = 0; n < 100; n++) {
          const ae = aborted(ro?.signal, model.id); if (ae) { end(ae); return; }
          let a: CodexAccount | undefined;
          try {
            a = await raceWithAbort(tried.size ? options.resolveAccount(ro?.signal, model.id, tried) : options.resolveAccount(ro?.signal, model.id), ro?.signal);
          } catch (e) {
            if (isAbort(e, ro?.signal)) { end(safeError("codex-multi request was aborted", true, model.id)); return; }
            if (!retryRefresh(e) || !(e instanceof TokenManagerError) || !e.accountKey) throw e;
            tried.add(e.accountKey); cats.push("refresh"); continue;
          }
          const ar = aborted(ro?.signal, model.id); if (ar) { end(ar); return; }
          if (!valid(a)) { end(tried.size ? safeError(`codex-multi exhausted ${tried.size} account attempts (${cats.join(",") || "unavailable"})`, false, model.id) : safeError("codex-multi is not configured: account resolver returned invalid credentials", false, model.id)); return; }
          if (tried.has(a.accountKey)) { end(safeError(`codex-multi exhausted ${tried.size} account attempts (${cats.join(",") || "duplicate"})`, false, model.id)); return; }
          tried.add(a.accountKey);
          let emitted = false, callbackFailed = false, responseHandled = false, status: number | undefined, headers: Record<string, string> = {};
          const buf: AssistantMessageEvent[] = [], caller = ro?.onResponse;
          const onResponse = async (r: any, m: any) => {
            if (responseHandled) return;
            responseHandled = true;
            if (ro?.signal?.aborted) throw abortError();
            status = r.status; headers = { ...r.headers };
            try { await raceWithAbort(caller?.(r, m), ro?.signal); } catch (e) { callbackFailed = true; throw e; }
            if (ro?.signal?.aborted) throw abortError();
          };
          const opts = { ...ro, apiKey: a.accessToken, headers: { ...(ro?.headers ?? {}), Authorization: `Bearer ${a.accessToken}`, "chatgpt-account-id": a.accountId }, onResponse, maxRetries: 0 };
          let it: AsyncIterator<AssistantMessageEvent> | undefined, closeRequested = false;
          const close = () => { if (!it || closeRequested) return; closeRequested = true; try { Promise.resolve(it.return?.()).catch(() => undefined); } catch { /* best effort */ } };
          try {
            const iterable = await raceWithAbort(transport(model as Model<Api>, context, opts), ro?.signal);
            it = iterable[Symbol.asyncIterator]();
            while (true) {
              const next = await raceWithAbort(it.next(), ro?.signal);
              if (next.done) break;
              if (ro?.signal?.aborted) { close(); throw abortError(); }
              if (substantive(next.value) && !emitted) { emitted = true; for (const e of buf.splice(0)) { if (ro?.signal?.aborted) throw abortError(); out.push(e); } }
              if (emitted) { if (ro?.signal?.aborted) throw abortError(); out.push(next.value); } else buf.push(next.value);
            }
            const terminal = buf.at(-1), usageLimit = isUsageLimitTerminal(terminal, emitted), can = !emitted && terminal?.type === "error" && ([401, 403, 429].includes(status ?? 0) || usageLimit);
            if (!can) { for (const e of buf) { if (ro?.signal?.aborted) throw abortError(); out.push(e); } end(); return; }
            if (status === 429 || usageLimit) { cats.push("rate-limited"); const t = now(), d = retryAfter(headers, t); await raceWithAbort(health(options.store, ro?.signal, a.accountKey, a.accessToken, a.refreshToken, (x, z) => ({ ...x, rateLimitedUntilByModel: { ...(x.rateLimitedUntilByModel ?? {}), [model.id]: cooldownDeadline(x, model.id, z, d) } }), t), ro?.signal); await raceWithAbort(sleep(d, ro?.signal), ro?.signal); }
            else { cats.push("auth"); await raceWithAbort(health(options.store, ro?.signal, a.accountKey, a.accessToken, a.refreshToken, (x, z) => ({ ...x, authInvalidAt: z }), now()), ro?.signal); }
            continue;
          } catch (e) {
            close();
            if (e instanceof StoreCommitUncertainError) throw e;
            if (isAbort(e, ro?.signal)) { end(safeError("codex-multi request was aborted", true, model.id)); return; }
            if (callbackFailed) { end(safeError("codex-multi request failed", false, model.id)); return; }
            const usageLimit = isUsageLimitTerminal(buf.at(-1), emitted), can = !emitted && (status === 401 || status === 403 || status === 429 || usageLimit || retryRefresh(e));
            if (!can) { for (const x of buf) out.push(x); end(buf.at(-1)?.type === "error" ? undefined : safeError("codex-multi request failed", false, model.id)); return; }
            if (status === 429 || usageLimit) { cats.push("rate-limited"); const t = now(), d = retryAfter(headers, t); await raceWithAbort(health(options.store, ro?.signal, a.accountKey, a.accessToken, a.refreshToken, (x, z) => ({ ...x, rateLimitedUntilByModel: { ...(x.rateLimitedUntilByModel ?? {}), [model.id]: cooldownDeadline(x, model.id, z, d) } }), t), ro?.signal); await raceWithAbort(sleep(d, ro?.signal), ro?.signal); }
            else if (status === 401 || status === 403) { cats.push("auth"); await raceWithAbort(health(options.store, ro?.signal, a.accountKey, a.accessToken, a.refreshToken, (x, z) => ({ ...x, authInvalidAt: z }), now()), ro?.signal); }
            else cats.push("refresh");
            continue;
          }
        }
        end(safeError(`codex-multi exhausted ${tried.size} account attempts (${cats.join(",") || "unavailable"})`, false, model.id));
      } catch (e) {
        if (isAbort(e, ro?.signal)) end(safeError("codex-multi request was aborted", true, model.id));
        else if (e instanceof AccountSelectionError && (e.code === "EMPTY_ACCOUNT_STORE" || e.code === "ALL_ACCOUNTS_UNAVAILABLE")) end(tried.size ? safeError(`codex-multi exhausted ${tried.size} account attempts (${cats.join(",") || "unavailable"})`, false, model.id) : safeError(e.message, false, model.id));
        else if (e instanceof StoreCommitUncertainError) end(safeError("codex-multi account health update is uncertain; request was not retried", false, model.id));
        else end(safeError("codex-multi request failed", false, model.id));
      }
    })().catch(() => undefined);
    return out;
  };
  return (pi: ExtensionAPI) => pi.registerProvider("codex-multi", { api: "openai-codex-responses", baseUrl: models[0]?.baseUrl, apiKey: "codex-multi-resolver", models, streamSimple: streamSimple as any });
}

export const defaultAccountStore = new AccountStore();
const defaultTokenManager = new TokenManager(defaultAccountStore);
export const defaultAccountResolver: AccountResolver = (s, m, e) => defaultTokenManager.prepare(s, m, { excludeAccountKeys: e });
