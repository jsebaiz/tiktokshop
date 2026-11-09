import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createHandler } from "../src/server/app";
import { resetAccessCertCache } from "../src/server/auth";
import { encryptString } from "../src/server/crypto";
import type { Env } from "../src/server/env";
import { d1sql, saveCredential, type Sql } from "../src/server/store";

export const TEST_KEY = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");

export interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

export interface DeskHarness {
  env: Env;
  sql: Sql;
  db: DatabaseSync;
  calls: FetchCall[];
  handle: (request: Request) => Promise<Response>;
  fetchImpl: typeof fetch;
}

export function createHarness(overrides: Partial<Env> = {}, responder?: (call: FetchCall) => Response | Promise<Response>): DeskHarness {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
  const calls: FetchCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = headersOf(init?.headers);
    let body = "";
    if (typeof init?.body === "string") body = init.body;
    else if (init?.body instanceof Uint8Array) body = new TextDecoder().decode(init.body);
    const call = { url, method: init?.method ?? "GET", headers, body };
    calls.push(call);
    if (responder) return responder(call);
    return new Response("unexpected", { status: 599 });
  };
  const env = {
    ...baseEnv(db),
    ...overrides,
  } as Env;
  const handle = createHandler({ fetch: fetchImpl, now: () => Date.now() });
  return { env, sql: d1sql(env.DB), db, calls, handle: (request) => handle(request, env), fetchImpl };
}

export function baseEnv(db: DatabaseSync): Env {
  return {
    DB: sqliteD1(db),
    ASSETS: {
      fetch: async (request: Request) => {
        const path = new URL(request.url).pathname;
        const files: Record<string, string> = {
          "/index.html": "<!doctype html><h1>Jesse Baizer</h1>",
          "/site.css": "body{}",
          "/favicon.svg": "<svg></svg>",
          "/robots.txt": "User-agent: *\nDisallow: /automate\n",
          "/automate/index.html": "<!doctype html><div id=app></div>",
          "/automate/app.js": "console.log('desk')",
          "/automate/app.css": "body{}",
        };
        const file = path === "/" ? "/index.html" : path;
        const body = files[file];
        if (!body) return new Response("missing", { status: 404 });
        return new Response(body, { headers: { "content-type": "text/html" } });
      },
    } as Fetcher,
    AUTOMATE_AUTH_MODE: "dev",
    AUTOMATE_ALLOW_DEV_AUTH: "1",
    AUTOMATE_DEV_PASSWORD: "test-password",
    SESSION_SECRET: "test-session-secret-32-characters-min",
    TOKEN_ENCRYPTION_KEY: TEST_KEY,
  };
}

export async function login(harness: DeskHarness): Promise<string> {
  const page = await harness.handle(new Request("http://127.0.0.1/automate/login"));
  const jar = cookieJar([page]);
  const csrf = cookieValue(jar, "automate_csrf");
  const response = await harness.handle(
    new Request("http://127.0.0.1/api/automate/session", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://127.0.0.1",
        cookie: jar,
        "x-automate-csrf": csrf,
      },
      body: JSON.stringify({ password: "test-password" }),
    }),
  );
  if (response.status !== 200) {
    throw new Error(`login failed ${response.status} ${await response.text()}`);
  }
  return cookieJar([page, response]);
}

export function authed(path: string, jar: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("cookie", jar);
  headers.set("origin", "http://127.0.0.1");
  if (init.method && init.method !== "GET" && init.method !== "HEAD") {
    headers.set("x-automate-csrf", cookieValue(jar, "automate_csrf"));
  }
  return new Request(`http://127.0.0.1${path}`, { ...init, headers });
}

export function cookieJar(responses: Response[]): string {
  const map = new Map<string, string>();
  for (const response of responses) {
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0] ?? "";
      const eq = pair.indexOf("=");
      if (eq > 0) map.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
  }
  return [...map.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
}

export function cookieValue(jar: string, name: string): string {
  for (const part of jar.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (trimmed.slice(0, eq) === name) return decodeURIComponent(trimmed.slice(eq + 1));
  }
  return "";
}

export async function connectGoogle(sql: Sql): Promise<void> {
  await saveCredential(sql, {
    email: "owner@example.com",
    refreshTokenEnc: await encryptString(TEST_KEY, "refresh-secret"),
    accessTokenEnc: await encryptString(TEST_KEY, "access-secret"),
    accessExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    scopes: "openid email https://www.googleapis.com/auth/drive.file",
    updatedAt: new Date().toISOString(),
  });
}

export function resetAuthCache(): void {
  resetAccessCertCache();
}

function headersOf(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) out[key.toLowerCase()] = value;
    return out;
  }
  for (const [key, value] of Object.entries(headers)) out[key.toLowerCase()] = value;
  return out;
}

function sqliteD1(db: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      const bound = (...params: unknown[]) => ({
        bind: (...next: unknown[]) => bound(...next),
        all: async () => {
          const results = params.length ? db.prepare(sql).all(...(params as [])) : db.prepare(sql).all();
          return { results, success: true, meta: meta(0) };
        },
        first: async () => {
          const row = params.length ? db.prepare(sql).get(...(params as [])) : db.prepare(sql).get();
          return row ?? null;
        },
        run: async () => {
          const info = params.length ? db.prepare(sql).run(...(params as [])) : db.prepare(sql).run();
          return { success: true, meta: meta(Number(info.changes ?? 0)) };
        },
      });
      return bound();
    },
    async exec(sql: string) {
      db.exec(sql);
    },
    async batch() {
      throw new Error("batch is not used");
    },
    async dump() {
      throw new Error("dump is not used");
    },
  } as unknown as D1Database;
}

function meta(changes: number) {
  return { changes, duration: 0, size_after: 0, rows_read: 0, rows_written: changes, last_row_id: 0 };
}
