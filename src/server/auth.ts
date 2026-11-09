import { base64UrlDecode, base64UrlEncode, hmacSign, randomToken, safeEqual } from "./crypto";
import type { Env } from "./env";
import { cookieHeader, html, HttpError, readCookie, requestIsSecure } from "./http";

export const SESSION_COOKIE = "automate_session";
export const CSRF_COOKIE = "automate_csrf";
const SESSION_TTL_SECONDS = 60 * 60 * 12;

export interface Identity {
  mode: "dev" | "access" | "public";
  email: string | null;
}

interface AccessJwk extends JsonWebKey {
  kid?: string;
}

interface AccessCertCache {
  expires: number;
  keys: Map<string, AccessJwk>;
}

let certCache: AccessCertCache | null = null;

export function devAuthEnabled(env: Env, request: Request): boolean {
  if (env.AUTOMATE_AUTH_MODE !== "dev") return false;
  if (env.AUTOMATE_ALLOW_DEV_AUTH !== "1") return false;
  if (!env.AUTOMATE_DEV_PASSWORD || !env.SESSION_SECRET || env.SESSION_SECRET.length < 32) return false;
  const host = new URL(request.url).hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

export function authConfigured(env: Env, request: Request): "dev" | "access" | "public" | "unconfigured" {
  if (devAuthEnabled(env, request)) return "dev";
  if (env.AUTOMATE_AUTH_MODE === "public") return "public";
  if (env.CF_ACCESS_TEAM_DOMAIN && env.CF_ACCESS_AUD) return "access";
  return "unconfigured";
}

export async function establishDevSession(password: string, env: Env, request: Request): Promise<string> {
  if (!devAuthEnabled(env, request) || !env.AUTOMATE_DEV_PASSWORD || !env.SESSION_SECRET) {
    throw new HttpError(404, "not_found");
  }
  if (!safeEqual(password, env.AUTOMATE_DEV_PASSWORD)) {
    throw new HttpError(401, "unauthorized", { detail: "Sign-in was not accepted." });
  }
  return signSession(env.SESSION_SECRET);
}

export async function readSession(request: Request, env: Env): Promise<Identity | null> {
  if (!devAuthEnabled(env, request) || !env.SESSION_SECRET) return null;
  const raw = readCookie(request, SESSION_COOKIE);
  if (!raw) return null;
  const ok = await verifySession(env.SESSION_SECRET, raw);
  if (!ok) return null;
  return { mode: "dev", email: env.AUTOMATE_OWNER_EMAIL ?? null };
}

export async function authenticateAccess(
  request: Request,
  env: Env,
  fetchImpl: typeof fetch,
  nowMs: number,
): Promise<Identity> {
  const team = env.CF_ACCESS_TEAM_DOMAIN?.trim();
  const aud = env.CF_ACCESS_AUD?.trim();
  if (!team || !aud) {
    throw new HttpError(503, "setup_needed", { integration: "auth", detail: "Cloudflare Access is not configured." });
  }
  if (!/^[a-z0-9.-]+$/i.test(team) || team.includes("..")) {
    throw new HttpError(503, "setup_needed", { integration: "auth", detail: "Cloudflare Access team domain is not valid." });
  }
  const token = request.headers.get("cf-access-jwt-assertion") ?? readCookie(request, "CF_Authorization");
  if (!token) {
    throw new HttpError(401, "unauthorized", { detail: "Cloudflare Access did not present a token." });
  }
  const email = await verifyAccessJwt(token, team, aud, fetchImpl, nowMs);
  if (env.AUTOMATE_OWNER_EMAIL && email?.toLowerCase() !== env.AUTOMATE_OWNER_EMAIL.toLowerCase()) {
    throw new HttpError(403, "forbidden", { detail: "This Access identity is not the desk owner." });
  }
  return { mode: "access", email };
}

export async function requireIdentity(
  request: Request,
  env: Env,
  fetchImpl: typeof fetch,
  nowMs: number,
): Promise<Identity> {
  const mode = authConfigured(env, request);
  if (mode === "unconfigured") {
    throw new HttpError(503, "setup_needed", {
      integration: "auth",
      detail: "Owner sign-in is not configured.",
    });
  }
  if (mode === "public") {
    return { mode: "public", email: env.AUTOMATE_OWNER_EMAIL ?? null };
  }
  if (mode === "dev") {
    const session = await readSession(request, env);
    if (!session) throw new HttpError(401, "unauthorized");
    return session;
  }
  return authenticateAccess(request, env, fetchImpl, nowMs);
}

export function sessionCookie(request: Request, token: string): string {
  return cookieHeader(SESSION_COOKIE, token, {
    maxAge: SESSION_TTL_SECONDS,
    httpOnly: true,
    secure: requestIsSecure(request),
  });
}

export function clearSessionCookie(request: Request): string {
  return cookieHeader(SESSION_COOKIE, "", { maxAge: 0, httpOnly: true, secure: requestIsSecure(request) });
}

export function issueCsrf(): string {
  return randomToken(32);
}

export function csrfCookie(request: Request, token: string): string {
  return cookieHeader(CSRF_COOKIE, token, {
    maxAge: SESSION_TTL_SECONDS,
    httpOnly: false,
    secure: requestIsSecure(request),
  });
}

export function assertCsrf(request: Request, formToken?: string | null): void {
  const cookie = readCookie(request, CSRF_COOKIE);
  const header = request.headers.get("x-automate-csrf");
  const presented = header || formToken || "";
  if (!cookie || !presented || !safeEqual(cookie, presented)) {
    throw new HttpError(403, "csrf");
  }
}

async function signSession(secret: string): Promise<string> {
  const payload = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify({ v: 1, exp: Date.now() + SESSION_TTL_SECONDS * 1000 })),
  );
  const signature = await hmacSign(secret, payload);
  return `${payload}.${signature}`;
}

async function verifySession(secret: string, token: string): Promise<boolean> {
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [payload, signature] = parts;
  if (!payload || !signature) return false;
  const expected = await hmacSign(secret, payload);
  if (!safeEqual(expected, signature)) return false;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload))) as { exp?: number; v?: number };
    if (parsed.v !== 1 || typeof parsed.exp !== "number") return false;
    return parsed.exp > Date.now();
  } catch {
    return false;
  }
}

async function verifyAccessJwt(
  token: string,
  team: string,
  audience: string,
  fetchImpl: typeof fetch,
  nowMs: number,
): Promise<string | null> {
  if (token.length > 8192) throw new HttpError(401, "unauthorized");
  const parts = token.split(".");
  if (parts.length !== 3) throw new HttpError(401, "unauthorized");
  const [headerPart, payloadPart, signaturePart] = parts;
  if (!headerPart || !payloadPart || !signaturePart) throw new HttpError(401, "unauthorized");
  let header: { alg?: string; kid?: string };
  let payload: { iss?: string; aud?: string | string[]; exp?: number; nbf?: number; email?: string };
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlDecode(headerPart))) as { alg?: string; kid?: string };
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadPart))) as typeof payload;
  } catch {
    throw new HttpError(401, "unauthorized");
  }
  if (header.alg !== "RS256" || !header.kid) throw new HttpError(401, "unauthorized");
  const expectedIss = `https://${team}`;
  if (payload.iss !== expectedIss) throw new HttpError(401, "unauthorized");
  const audiences = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
  if (!audiences.includes(audience)) throw new HttpError(401, "unauthorized");
  const skew = 60_000;
  if (typeof payload.exp !== "number" || payload.exp * 1000 + skew < nowMs) throw new HttpError(401, "unauthorized");
  if (typeof payload.nbf === "number" && payload.nbf * 1000 - skew > nowMs) throw new HttpError(401, "unauthorized");
  const jwk = await accessKey(team, header.kid, fetchImpl, nowMs);
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64UrlDecode(signaturePart),
    new TextEncoder().encode(`${headerPart}.${payloadPart}`),
  );
  if (!valid) throw new HttpError(401, "unauthorized");
  return typeof payload.email === "string" ? payload.email : null;
}

async function accessKey(team: string, kid: string, fetchImpl: typeof fetch, nowMs: number): Promise<AccessJwk> {
  const load = async (force: boolean): Promise<AccessJwk | undefined> => {
    if (!force && certCache && certCache.expires > nowMs) return certCache.keys.get(kid);
    const response = await fetchImpl(`https://${team}/cdn-cgi/access/certs`, { redirect: "manual" });
    if (response.status !== 200) {
      throw new HttpError(401, "unauthorized", { detail: "Access certificates could not be loaded." });
    }
    const body = (await response.json()) as { keys?: AccessJwk[] };
    const keys = new Map<string, AccessJwk>();
    for (const key of body.keys ?? []) {
      if (key.kid && key.kty === "RSA") keys.set(key.kid, key);
    }
    certCache = { expires: nowMs + 60 * 60 * 1000, keys };
    return keys.get(kid);
  };
  const found = (await load(false)) ?? (await load(true));
  if (!found) throw new HttpError(401, "unauthorized");
  return found;
}

export function resetAccessCertCache(): void {
  certCache = null;
}

export function plainAuthPage(title: string, message: string, status: number): Response {
  return html(
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
</head>
<body style="margin:0;background:#12100c;color:#f4efe6;font-family:Georgia,serif">
  <main style="max-width:36rem;margin:12vh auto;padding:0 1.25rem">
    <p style="letter-spacing:.14em;text-transform:uppercase;font-family:sans-serif;font-size:.75rem;color:#e4b15a">Jesse Baizer</p>
    <h1 style="font-weight:500;font-size:2.4rem;margin:.2rem 0 1rem">${title}</h1>
    <p style="font-family:sans-serif;line-height:1.5;color:#d9d0c3">${message}</p>
  </main>
</body>
</html>`,
    status,
  );
}
