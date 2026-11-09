import { sanitizeMessage } from "./crypto";

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail?: string;
  readonly integration?: string;
  readonly extra?: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    options?: { detail?: string; integration?: string; extra?: Record<string, unknown> },
  ) {
    super(code);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.detail = options?.detail;
    this.integration = options?.integration;
    this.extra = options?.extra;
  }
}

export function json(data: unknown, status = 200, extra?: HeadersInit): Response {
  const headers = new Headers(extra);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  return new Response(JSON.stringify(data), { status, headers });
}

export function errorResponse(error: HttpError): Response {
  const body: Record<string, unknown> = { error: error.code };
  if (error.detail) body.detail = sanitizeMessage(error.detail, 500);
  if (error.integration) body.integration = error.integration;
  if (error.extra) {
    for (const [key, value] of Object.entries(error.extra)) body[key] = value;
  }
  return json(body, error.status);
}

export interface FetchPolicy {
  hosts: string[];
  path: RegExp;
  allowQuery?: boolean;
}

export async function safeFetch(
  fetchImpl: typeof fetch,
  target: string,
  init: RequestInit,
  policy: FetchPolicy,
): Promise<Response> {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new HttpError(400, "blocked_url");
  }
  if (url.protocol !== "https:") throw new HttpError(400, "blocked_url");
  if (url.username || url.password) throw new HttpError(400, "blocked_url");
  if (url.port !== "" && url.port !== "443") throw new HttpError(400, "blocked_url");
  if (!policy.hosts.includes(url.hostname)) throw new HttpError(400, "blocked_url");
  if (!policy.path.test(url.pathname)) throw new HttpError(400, "blocked_url");
  if (!policy.allowQuery && url.search) throw new HttpError(400, "blocked_url");
  return fetchImpl(url.toString(), { ...init, redirect: "manual" });
}

export function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

export async function readJson(request: Request, max = 32_000): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > max) throw new HttpError(413, "too_large");
  const text = await request.text();
  if (text.length > max) throw new HttpError(413, "too_large");
  if (!text) throw new HttpError(400, "bad_json");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, "bad_json");
  }
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) === name) return decodeURIComponent(trimmed.slice(eq + 1));
  }
  return null;
}

export function cookieHeader(
  name: string,
  value: string,
  options: { maxAge: number; httpOnly: boolean; secure: boolean },
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${options.maxAge}`,
  ];
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

export function requestIsSecure(request: Request): boolean {
  const url = new URL(request.url);
  if (url.protocol === "https:") return true;
  return request.headers.get("x-forwarded-proto") === "https";
}

export function html(body: string, status: number, extra?: HeadersInit): Response {
  const headers = new Headers(extra);
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("referrer-policy", "strict-origin-when-cross-origin");
  headers.set("x-robots-tag", "noindex, nofollow");
  headers.set(
    "content-security-policy",
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  );
  return new Response(body, { status, headers });
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

export function sameOrigin(request: Request): boolean {
  const expected = new URL(request.url).origin;
  const origin = request.headers.get("origin");
  if (origin) return origin === expected;
  const fetchSite = request.headers.get("sec-fetch-site");
  if (!fetchSite) return true;
  return fetchSite === "same-origin" || fetchSite === "none";
}

export function wantsHtml(request: Request): boolean {
  return (request.headers.get("accept") ?? "").includes("text/html");
}
