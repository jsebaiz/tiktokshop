import { createSign, generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { resetAccessCertCache } from "../src/server/auth";
import { authed, connectGoogle, cookieValue, createHarness, login, type FetchCall } from "./harness";

const WEBHOOK = "https://api2.cursor.sh/automations/webhook/routine123";
const WEBHOOK_KEY = "crsr_test_key_value";

beforeEach(() => {
  resetAccessCertCache();
});

describe("rejected auth", () => {
  it("rejects the desk and its API without a session, and leaves the public site open", async () => {
    const harness = createHarness();
    const home = await harness.handle(new Request("http://127.0.0.1/"));
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("Jesse Baizer");

    const api = await harness.handle(new Request("http://127.0.0.1/api/automate/bootstrap"));
    expect(api.status).toBe(401);

    const page = await harness.handle(
      new Request("http://127.0.0.1/automate", { headers: { accept: "text/html" } }),
    );
    expect(page.status).toBe(302);
    expect(page.headers.get("location")).toBe("/automate/login");

    const script = await harness.handle(new Request("http://127.0.0.1/automate/app.js"));
    expect(script.status).toBe(401);

    const missing = await harness.handle(new Request("http://127.0.0.1/no-such-page"));
    expect(missing.status).toBe(404);
    const icon = await harness.handle(new Request("http://127.0.0.1/favicon.ico"));
    expect(icon.status).toBe(200);

    const loginPage = await harness.handle(new Request("http://127.0.0.1/automate/login"));
    const jar = cookieHeaderFrom(loginPage);
    const wrong = await harness.handle(
      new Request("http://127.0.0.1/api/automate/session", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://127.0.0.1",
          cookie: jar,
          "x-automate-csrf": cookieValue(jar, "automate_csrf"),
        },
        body: JSON.stringify({ password: "nope" }),
      }),
    );
    expect(wrong.status).toBe(401);
  });

  it("rejects a Cloudflare Access token with a bad signature, audience, or owner email", async () => {
    const { privateKey, jwk } = await keyPair();
    const harness = createHarness(
      {
        AUTOMATE_AUTH_MODE: "access",
        AUTOMATE_ALLOW_DEV_AUTH: undefined,
        CF_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
        CF_ACCESS_AUD: "audience-tag",
        AUTOMATE_OWNER_EMAIL: "owner@example.com",
      },
      (call) => certs(call, jwk),
    );
    const missing = await harness.handle(new Request("http://127.0.0.1/api/automate/bootstrap"));
    expect(missing.status).toBe(401);

    const bad = await harness.handle(
      new Request("http://127.0.0.1/api/automate/bootstrap", {
        headers: { "cf-access-jwt-assertion": "a.b.c" },
      }),
    );
    expect(bad.status).toBe(401);

    const wrongAud = signJwt(privateKey, { aud: "other", email: "owner@example.com" });
    const aud = await harness.handle(
      new Request("http://127.0.0.1/api/automate/bootstrap", {
        headers: { "cf-access-jwt-assertion": wrongAud },
      }),
    );
    expect(aud.status).toBe(401);

    const other = signJwt(privateKey, { aud: "audience-tag", email: "other@example.com" });
    const forbidden = await harness.handle(
      new Request("http://127.0.0.1/api/automate/bootstrap", {
        headers: { "cf-access-jwt-assertion": other },
      }),
    );
    expect(forbidden.status).toBe(403);

    const good = signJwt(privateKey, { aud: "audience-tag", email: "owner@example.com" });
    const ok = await harness.handle(
      new Request("http://127.0.0.1/api/automate/bootstrap", {
        headers: { "cf-access-jwt-assertion": good },
      }),
    );
    expect(ok.status).toBe(200);
  });

  it("does not honor the dev password outside localhost", async () => {
    const harness = createHarness();
    const response = await harness.handle(
      new Request("https://example.com/api/automate/session", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://example.com" },
        body: JSON.stringify({ password: "test-password" }),
      }),
    );
    expect(response.status).toBe(404);
  });
});

describe("jobs", () => {
  it("treats a webhook 200 as accepted but not completed", async () => {
    const harness = createHarness(webhookEnv(), () => jsonResponse({ success: true, runUuid: "run-12345678" }));
    const jar = await login(harness);
    const response = await harness.handle(
      authed("/api/automate/jobs", jar, {
        method: "POST",
        body: JSON.stringify({ agent: "fling", task: "summarize-inbox", idempotencyKey: "idem-key-1" }),
      }),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as { job: { id: string; status: string; delivery: string } };
    expect(body.job.status).toBe("requested");
    expect(body.job.delivery).toBe("accepted");
    expect(body.job.status).not.toBe("completed");
    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]?.url).toBe(WEBHOOK);
    expect(harness.calls[0]?.headers.authorization).toBe(`Bearer ${WEBHOOK_KEY}`);
    expect(harness.calls[0]?.headers["x-automation-key"]).toBe(WEBHOOK_KEY);
    expect(harness.calls[0]?.body).not.toContain(WEBHOOK_KEY);
    const sent = JSON.parse(harness.calls[0]?.body ?? "{}") as { jobId: string; task: string };
    expect(sent.jobId).toBe(body.job.id);
    expect(sent.task).toBe("summarize-inbox");
  });

  it("does not send a second webhook for a duplicate start", async () => {
    const harness = createHarness(webhookEnv(), () => jsonResponse({ success: true, runUuid: "run-12345678" }));
    const jar = await login(harness);
    const first = await harness.handle(start(jar, "idem-dup-1"));
    const second = await harness.handle(start(jar, "idem-dup-1"));
    const a = (await first.json()) as { job: { id: string } };
    const b = (await second.json()) as { job: { id: string }; created: boolean };
    expect(b.job.id).toBe(a.job.id);
    expect(b.created).toBe(false);
    expect(harness.calls).toHaveLength(1);
  });

  it("reports setup needed and does not call out when the webhook is missing", async () => {
    const harness = createHarness({}, () => jsonResponse({}));
    const jar = await login(harness);
    const response = await harness.handle(start(jar, "idem-missing-1"));
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string; integration: string };
    expect(body.error).toBe("setup_needed");
    expect(body.integration).toBe("webhook");
    expect(harness.calls).toHaveLength(0);
    const jobs = await harness.handle(authed("/api/automate/jobs", jar));
    const listed = (await jobs.json()) as { jobs: unknown[] };
    expect(listed.jobs).toEqual([]);
  });

  it("rejects a webhook host that is not api2.cursor.sh", async () => {
    const harness = createHarness(
      { ...webhookEnv(), WEBHOOK_URL_FLING: "https://evil.example/automations/webhook/routine123" },
      () => jsonResponse({}),
    );
    const jar = await login(harness);
    const response = await harness.handle(start(jar, "idem-host-1"));
    expect(response.status).toBe(409);
    const body = (await response.json()) as { integration: string };
    expect(body.integration).toBe("webhook_host");
    expect(harness.calls).toHaveLength(0);
  });

  it("marks a requested job unknown once it is stale", async () => {
    const harness = createHarness(webhookEnv(), () => jsonResponse({ success: true, runUuid: "run-12345678" }));
    const jar = await login(harness);
    const created = await harness.handle(start(jar, "idem-stale-1"));
    const job = ((await created.json()) as { job: { id: string } }).job;
    const old = new Date(Date.now() - 16 * 60 * 1000).toISOString();
    harness.db.prepare("UPDATE jobs SET updated_at = ? WHERE id = ?").run(old, job.id);
    const listed = await harness.handle(authed("/api/automate/jobs", jar));
    const body = (await listed.json()) as { jobs: Array<{ id: string; status: string; stale: boolean }> };
    expect(body.jobs[0]?.status).toBe("unknown");
    expect(body.jobs[0]?.stale).toBe(true);

    harness.db.prepare("UPDATE jobs SET status = 'running', updated_at = ?, stale = 0 WHERE id = ?").run(
      new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      job.id,
    );
    const again = await harness.handle(authed(`/api/automate/jobs/${job.id}`, jar));
    const running = (await again.json()) as { job: { status: string; stale: boolean } };
    expect(running.job.status).toBe("running");
    expect(running.job.stale).toBe(true);
  });

  it("keeps a posting job unknown when completion has no published URL", async () => {
    const harness = createHarness(
      { ...webhookEnv(), WEBHOOK_URL_SLING: WEBHOOK, WEBHOOK_KEY_SLING: WEBHOOK_KEY, PUBLIC_BASE_URL: "https://jessebaizer.com" },
      () => jsonResponse({ success: true, runUuid: "run-12345678" }),
    );
    const jar = await login(harness);
    const response = await harness.handle(
      authed("/api/automate/jobs", jar, {
        method: "POST",
        body: JSON.stringify({ agent: "sling", task: "post-next-brand", idempotencyKey: "idem-post-1" }),
      }),
    );
    const started = (await response.json()) as { job: { id: string; status: string } };
    expect(started.job.status).toBe("requested");
    const sent = JSON.parse(harness.calls[0]?.body ?? "{}") as { report?: { authorization: string } };
    const token = sent.report?.authorization.slice("Bearer ".length) ?? "";
    expect(token.length).toBeGreaterThan(20);
    expect(JSON.stringify(started)).not.toContain(token);
    const report = await harness.handle(
      new Request(`http://127.0.0.1/api/automate/jobs/${started.job.id}/report`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ status: "completed", note: "posted" }),
      }),
    );
    expect(report.status).toBe(200);
    const reported = (await report.json()) as { job: { status: string; outputUrl: string | null } };
    expect(reported.job.status).toBe("unknown");
    expect(reported.job.outputUrl).toBeNull();

    const bad = await harness.handle(
      new Request(`http://127.0.0.1/api/automate/jobs/${started.job.id}/report`, {
        method: "POST",
        headers: { authorization: "Bearer wrong-token", "content-type": "application/json" },
        body: JSON.stringify({ status: "running" }),
      }),
    );
    expect(bad.status).toBe(401);
  });

  it("rejects a mutation without the CSRF token", async () => {
    const harness = createHarness(webhookEnv(), () => jsonResponse({ success: true }));
    const jar = await login(harness);
    const response = await harness.handle(
      new Request("http://127.0.0.1/api/automate/jobs", {
        method: "POST",
        headers: {
          cookie: jar,
          origin: "http://127.0.0.1",
          "content-type": "application/json",
        },
        body: JSON.stringify({ agent: "fling", task: "summarize-inbox", idempotencyKey: "idem-csrf-1" }),
      }),
    );
    expect(response.status).toBe(403);
    expect(harness.calls).toHaveLength(0);
  });
});

describe("uploads", () => {
  it("surfaces an upload failure and does not pretend the file arrived", async () => {
    const harness = createHarness({}, (call) => {
      if (call.method === "POST" && call.url.includes("uploadType=resumable")) {
        return new Response(null, {
          status: 200,
          headers: {
            location: "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=secret-session",
          },
        });
      }
      if (call.method === "PUT") return new Response("backend", { status: 500 });
      return new Response("unexpected", { status: 599 });
    });
    await connectGoogle(harness.sql);
    const jar = await login(harness);
    const started = await harness.handle(
      authed("/api/automate/drive/uploads", jar, {
        method: "POST",
        body: JSON.stringify({ folderKey: "brands", name: "look.jpg", mimeType: "image/jpeg", size: 4 }),
      }),
    );
    expect(started.status).toBe(201);
    const upload = (await started.json()) as { uploadId: string };
    expect(JSON.stringify(upload)).not.toContain("secret-session");
    expect(JSON.stringify(upload)).not.toContain("googleapis");
    const chunk = await harness.handle(
      authed(`/api/automate/drive/uploads/${upload.uploadId}`, jar, {
        method: "PUT",
        headers: { "content-range": "bytes 0-3/4" },
        body: new Uint8Array([1, 2, 3, 4]),
      }),
    );
    expect(chunk.status).toBe(502);
    const failed = (await chunk.json()) as { error: string; retryable: boolean; detail: string };
    expect(failed.error).toBe("upload_failed");
    expect(failed.retryable).toBe(true);
    expect(failed.detail).toContain("HTTP 500");
    expect(JSON.stringify(failed)).not.toContain("secret-session");
    const row = harness.db.prepare("SELECT status, error FROM upload_sessions WHERE id = ?").get(upload.uploadId) as {
      status: string;
      error: string;
    };
    expect(row.status).toBe("failed");
  });

  it("does not upload when Google is not connected", async () => {
    const harness = createHarness();
    const jar = await login(harness);
    const response = await harness.handle(
      authed("/api/automate/drive/uploads", jar, {
        method: "POST",
        body: JSON.stringify({ folderKey: "brands", name: "look.jpg", mimeType: "image/jpeg", size: 4 }),
      }),
    );
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string; integration: string };
    expect(body.error).toBe("setup_needed");
    expect(body.integration).toBe("google");
    expect(harness.calls).toHaveLength(0);
  });

  it("rejects a folder that is not allowlisted", async () => {
    const harness = createHarness({}, () => new Response("no", { status: 404 }));
    await connectGoogle(harness.sql);
    const jar = await login(harness);
    const response = await harness.handle(
      authed("/api/automate/drive/uploads", jar, {
        method: "POST",
        body: JSON.stringify({
          folderId: "nope",
          name: "look.jpg",
          mimeType: "image/jpeg",
          size: 4,
        }),
      }),
    );
    expect(response.status).toBe(400);
    expect(harness.calls).toHaveLength(0);
  });
});

function webhookEnv() {
  return { WEBHOOK_URL_FLING: WEBHOOK, WEBHOOK_KEY_FLING: WEBHOOK_KEY };
}

function start(jar: string, key: string): Request {
  return authed("/api/automate/jobs", jar, {
    method: "POST",
    body: JSON.stringify({ agent: "fling", task: "summarize-inbox", idempotencyKey: key }),
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function cookieHeaderFrom(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

function certs(call: FetchCall, jwk: JsonWebKey): Response {
  if (call.url === "https://team.cloudflareaccess.com/cdn-cgi/access/certs") {
    return jsonResponse({ keys: [jwk] });
  }
  return new Response("unexpected", { status: 599 });
}

async function keyPair(): Promise<{ privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"]; jwk: JsonWebKey }> {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" }) as JsonWebKey;
  jwk.kid = "test-key";
  jwk.alg = "RS256";
  jwk.use = "sig";
  return { privateKey, jwk };
}

function signJwt(
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
  claims: { aud: string; email: string },
): string {
  const header = b64url(JSON.stringify({ alg: "RS256", kid: "test-key", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(
    JSON.stringify({
      iss: "https://team.cloudflareaccess.com",
      aud: claims.aud,
      exp: now + 300,
      nbf: now - 10,
      email: claims.email,
    }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  signer.end();
  const signature = signer.sign(privateKey);
  return `${header}.${payload}.${b64url(signature)}`;
}

function b64url(value: string | Buffer): string {
  const buffer = typeof value === "string" ? Buffer.from(value) : value;
  return buffer.toString("base64url");
}
