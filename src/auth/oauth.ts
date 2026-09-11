import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { URLSearchParams } from "node:url";

export const OPENAI_ISSUER = "https://auth.openai.com";
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_REDIRECT_PORTS = [1455, 1456, 1457, 1458, 1459] as const;
const CALLBACK_PATH = "/auth/callback";
const SCOPES = "openid profile email offline_access";
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface AuthorizationFlow { readonly pkce: { readonly verifier: string; readonly challenge: string }; readonly state: string; readonly url: string; readonly redirectUri: string; readonly port: number; }
export interface LoginOptions { signal?: AbortSignal; timeoutMs?: number; fetch?: FetchLike; ports?: readonly number[]; }
export interface OAuthTokens { access_token: string; refresh_token?: string; id_token?: string; expires_in?: number; [key: string]: unknown; }
function invalidTokenResponse(): OAuthError { return new OAuthError("INVALID_TOKEN_RESPONSE", "OAuth token response is invalid"); }
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
export function decodeJwtClaims(token: string): Record<string, unknown> {
  const parts = token.split("."); if (parts.length !== 3 || parts.some((part) => part.length === 0)) throw invalidTokenResponse();
  try {
    const decode = (part: string) => { if (!/^[A-Za-z0-9_-]+$/.test(part) || part.length % 4 === 1) throw new Error(); const bytes = Buffer.from(part, "base64url"); if (bytes.toString("base64url") !== part) throw new Error(); return bytes; };
    const header: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decode(parts[0])));
    const payload: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decode(parts[1])));
    decode(parts[2]);
    if (!isRecord(header) || !isRecord(payload)) throw new Error();
    return payload;
  } catch { throw invalidTokenResponse(); }
}
function validateClaimTypes(claim: Record<string, unknown>) {
  for (const key of ["account_id", "chatgpt_account_id", "https://api.openai.com/auth/account_id", "email", "plan_type", "chatgpt_plan_type"]) if (key in claim && typeof claim[key] !== "string") throw invalidTokenResponse();
  if ("exp" in claim && (typeof claim.exp !== "number" || !Number.isFinite(claim.exp) || claim.exp <= 0)) throw invalidTokenResponse();
  for (const key of ["https://api.openai.com/auth", "https://api.openai.com/profile"]) if (key in claim && !isRecord(claim[key])) throw invalidTokenResponse();
}
export function tokenIdentity(tokens: OAuthTokens, now?: number, requireAccountId?: true): { accountId: string; email?: string; planType?: string; expiresAt: number };
export function tokenIdentity(tokens: OAuthTokens, now: number, requireAccountId: false): { accountId?: string; email?: string; planType?: string; expiresAt: number };
export function tokenIdentity(tokens: OAuthTokens, now = Date.now(), requireAccountId = true): { accountId?: string; email?: string; planType?: string; expiresAt: number } {
  const access = decodeJwtClaims(tokens.access_token), id = tokens.id_token ? decodeJwtClaims(tokens.id_token) : {};
  validateClaimTypes(access); validateClaimTypes(id);
  const authClaims = [id["https://api.openai.com/auth"], access["https://api.openai.com/auth"]].filter(isRecord);
  const profileClaims = [id["https://api.openai.com/profile"], access["https://api.openai.com/profile"]].filter(isRecord);
  authClaims.forEach(validateClaimTypes); profileClaims.forEach(validateClaimTypes);
  const accountId = [id.account_id, access.account_id, id.chatgpt_account_id, access.chatgpt_account_id, ...authClaims.flatMap((c) => [c.account_id, c.chatgpt_account_id, c["https://api.openai.com/auth/account_id"]])].find((v): v is string => typeof v === "string" && v.length > 0);
  if (requireAccountId && !accountId) throw new OAuthError("MISSING_ACCOUNT_ID", "OAuth response did not contain an account identity");
  const email = [id.email, access.email, ...profileClaims.map((c) => c.email)].find((v): v is string => typeof v === "string");
  const planType = [id.plan_type, access.plan_type, ...authClaims.map((c) => c.chatgpt_plan_type)].find((v): v is string => typeof v === "string");
  const exp = [access.exp, id.exp].find((v): v is number => typeof v === "number" && Number.isFinite(v) && v > now / 1000);
  const expiresAt = exp ? exp * 1000 : tokens.expires_in && Number.isFinite(tokens.expires_in) && tokens.expires_in > 0 ? now + tokens.expires_in * 1000 : undefined;
  if (!expiresAt || !Number.isSafeInteger(Math.floor(expiresAt)) || expiresAt <= now) throw invalidTokenResponse();
  return { accountId, email, planType, expiresAt };
}
export type OAuthErrorCode = "OAUTH_ABORTED" | "OAUTH_TIMEOUT" | "OAUTH_CALLBACK" | "OAUTH_EXCHANGE" | "INVALID_TOKEN_RESPONSE" | "MISSING_ACCOUNT_ID";
export class OAuthError extends Error {
  readonly code: OAuthErrorCode; readonly status?: number;
  constructor(code: OAuthErrorCode, message: string, status?: number) { super(message); this.code = code; Object.defineProperty(this, "name", { value: "OAuthError", enumerable: false }); Object.defineProperty(this, "code", { value: code, enumerable: false }); if (status !== undefined) { this.status = status; Object.defineProperty(this, "status", { value: status, enumerable: false }); } }
}
function pkce() { const verifier = randomBytes(32).toString("base64url"); return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") }; }
export async function createAuthorizationFlow(port: number = CODEX_REDIRECT_PORTS[0]): Promise<AuthorizationFlow> {
  if (!(CODEX_REDIRECT_PORTS as readonly number[]).includes(port)) throw new OAuthError("OAUTH_CALLBACK", "OAuth redirect port is outside the allowed range");
  const pair = pkce(), state = randomBytes(32).toString("base64url"), redirectUri = `http://localhost:${port}${CALLBACK_PATH}`; const auth = new URL(`${OPENAI_ISSUER}/oauth/authorize`);
  for (const [key, value] of Object.entries({ client_id: CODEX_CLIENT_ID, redirect_uri: redirectUri, response_type: "code", scope: SCOPES, code_challenge: pair.challenge, code_challenge_method: "S256", state, audience: "https://api.openai.com/v1", id_token_add_organizations: "true", codex_cli_simplified_flow: "true", originator: "codex_cli_rs" })) auth.searchParams.set(key, value);
  return { pkce: pair, state, url: auth.toString(), redirectUri, port };
}
function escapedHtml(text: string) { return `<!doctype html><html><body><h1>${text}</h1><p>You can close this window.</p></body></html>`; }
async function listen(server: ReturnType<typeof createServer>, ports: readonly number[]) {
  for (const port of ports) try { await new Promise<void>((resolve, reject) => { const fail = (e: NodeJS.ErrnoException) => { server.off("error", fail); reject(e); }; server.once("error", fail); server.listen(port, "127.0.0.1", () => { server.off("error", fail); resolve(); }); }); return port; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e; }
  throw new OAuthError("OAUTH_CALLBACK", "No OAuth callback port is available");
}
function parseTokenResponse(value: unknown, requireRefresh: boolean): OAuthTokens {
  const usableString = (candidate: unknown): candidate is string => typeof candidate === "string" && candidate.trim().length > 0;
  if (!isRecord(value) || !usableString(value.access_token)) throw invalidTokenResponse();
  if (requireRefresh && !usableString(value.refresh_token)) throw invalidTokenResponse();
  for (const key of ["refresh_token", "id_token"]) if (key in value && value[key] !== undefined && !usableString(value[key])) throw invalidTokenResponse();
  if ("expires_in" in value && (typeof value.expires_in !== "number" || !Number.isFinite(value.expires_in) || value.expires_in <= 0)) throw invalidTokenResponse(); return value as OAuthTokens;
}
async function exchange(flow: AuthorizationFlow, code: string, fetchImpl: FetchLike, signal?: AbortSignal): Promise<OAuthTokens> {
  if (signal?.aborted) throw new OAuthError("OAUTH_ABORTED", "OAuth login was aborted"); let response: Response;
  try { response = await fetchImpl(`${OPENAI_ISSUER}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: CODEX_CLIENT_ID, code, code_verifier: flow.pkce.verifier, redirect_uri: flow.redirectUri }), signal }); } catch { if (signal?.aborted) throw new OAuthError("OAUTH_ABORTED", "OAuth login was aborted"); throw new OAuthError("OAUTH_EXCHANGE", "OAuth token exchange failed"); }
  if (!response.ok) throw new OAuthError("OAUTH_EXCHANGE", "OAuth token exchange failed", response.status); try { return parseTokenResponse(await response.json(), true); } catch (error) { if (error instanceof OAuthError) throw error; throw invalidTokenResponse(); }
}
export interface LoginOperation extends Promise<{ alias: string; tokens: OAuthTokens; identity: ReturnType<typeof tokenIdentity> }> {
  readonly ready: Promise<AuthorizationFlow>;
  getFlow(): AuthorizationFlow;
}
export function loginAccount(alias: string, options: LoginOptions = {}): LoginOperation {
  const fetchImpl = options.fetch ?? fetch, ports = options.ports ?? CODEX_REDIRECT_PORTS; const server = createServer(); const sockets = new Set<Socket | Duplex>(); let flow!: AuthorizationFlow; let settled = false; let timer: NodeJS.Timeout | undefined;
      let readyResolve!: (flow: AuthorizationFlow) => void;
      let readyReject!: (error: OAuthError) => void;
      const ready = new Promise<AuthorizationFlow>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const trackSocket = (socket: Socket | Duplex) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); };
  server.on("connection", trackSocket); server.on("upgrade", (_request, socket) => trackSocket(socket));
  const result = new Promise<{ alias: string; tokens: OAuthTokens; identity: ReturnType<typeof tokenIdentity> }>(async (resolve, reject) => {
    const abort = () => { void fail(new OAuthError("OAUTH_ABORTED", "OAuth login was aborted")); };
    let cleanupPromise: Promise<void> | undefined;
    const cleanup = () => cleanupPromise ??= (async () => {
      if (timer) clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
      server.off("connection", trackSocket); server.removeAllListeners("upgrade");
      const closed = new Promise<void>((done) => { if (!server.listening) done(); else { try { server.close(() => done()); } catch { done(); } } });
      for (const socket of sockets) socket.destroy();
      await Promise.race([closed, new Promise<void>((done) => { const safeguard = setTimeout(done, 1_000); safeguard.unref(); })]);
      server.removeAllListeners("request");
    })();
    const fail = async (error: OAuthError) => { if (settled) return; settled = true; readyReject(error); await cleanup(); reject(error); };
    if (options.signal?.aborted) return fail(new OAuthError("OAUTH_ABORTED", "OAuth login was aborted")); options.signal?.addEventListener("abort", abort, { once: true });
    server.on("request", async (req: IncomingMessage, res: ServerResponse) => {
      const request = new URL(req.url ?? "", "http://127.0.0.1"); if (request.pathname !== CALLBACK_PATH) { res.writeHead(404); res.end(escapedHtml("Not found")); return; }
      const state = request.searchParams.get("state"), code = request.searchParams.get("code"); if (!state || state !== flow.state) { res.writeHead(400); res.end(escapedHtml("Invalid callback")); void fail(new OAuthError("OAUTH_CALLBACK", "OAuth callback state was rejected")); return; }
      if (!code) { res.writeHead(400); res.end(escapedHtml("Invalid callback")); void fail(new OAuthError("OAUTH_CALLBACK", "OAuth callback was rejected")); return; }
      try { const tokens = await exchange(flow, code, fetchImpl, options.signal); const identity = tokenIdentity(tokens); if (settled) return; res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(escapedHtml("Authentication complete")); settled = true; await cleanup(); resolve({ alias, tokens, identity }); } catch (e) { if (!settled) { res.writeHead(500); res.end(escapedHtml("Authentication failed")); } void fail(e instanceof OAuthError ? e : new OAuthError("OAUTH_EXCHANGE", "OAuth token exchange failed")); }
    });
    try { const port = await listen(server, ports); flow = await createAuthorizationFlow(port); readyResolve(flow); timer = setTimeout(() => { void fail(new OAuthError("OAUTH_TIMEOUT", "OAuth login timed out")); }, options.timeoutMs ?? 300_000); } catch (e) { void fail(e instanceof OAuthError ? e : new OAuthError("OAUTH_CALLBACK", "OAuth callback server failed")); }
  }); return Object.assign(result, { ready, getFlow: () => flow }) as LoginOperation;
}
export async function refreshOAuthToken(refreshToken: string, options: { fetch?: FetchLike; signal?: AbortSignal } = {}): Promise<OAuthTokens> {
  if (options.signal?.aborted) throw new OAuthError("OAUTH_ABORTED", "OAuth refresh was aborted");
  if (typeof refreshToken !== "string" || refreshToken.trim().length === 0) throw invalidTokenResponse();
  let response: Response;
  try { response = await (options.fetch ?? fetch)(`${OPENAI_ISSUER}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", client_id: CODEX_CLIENT_ID, refresh_token: refreshToken }), signal: options.signal }); } catch { if (options.signal?.aborted) throw new OAuthError("OAUTH_ABORTED", "OAuth refresh was aborted"); throw new OAuthError("OAUTH_EXCHANGE", "OAuth token refresh failed"); }
  if (!response.ok) throw new OAuthError("OAUTH_EXCHANGE", "OAuth token refresh failed", response.status); try { return parseTokenResponse(await response.json(), false); } catch (error) { if (error instanceof OAuthError) throw error; throw invalidTokenResponse(); }
}
