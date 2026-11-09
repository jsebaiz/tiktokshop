import { AGENTS, DRIVE_CHUNK_MULTIPLE, IMAGE_MIME_TYPES, MAX_UPLOAD_BYTES, UPLOAD_CHUNK_BYTES } from "../shared/catalog";
import { isDriveId } from "../shared/urls";
import {
  assertCsrf,
  authConfigured,
  clearSessionCookie,
  csrfCookie,
  devAuthEnabled,
  establishDevSession,
  issueCsrf,
  plainAuthPage,
  requireIdentity,
  sessionCookie,
  type Identity,
} from "./auth";
import { CSRF_COOKIE } from "./auth";
import { encryptionReady, encryptString, decryptString, randomToken, sanitizeMessage } from "./crypto";
import type { Env } from "./env";
import {
  codeChallenge,
  connectionSummary,
  downloadThumbnail,
  exchangeCode,
  folderIsAllowed,
  getDriveFile,
  googleOauthConfigured,
  listDriveFolder,
  probeUpload,
  putUploadChunk,
  requestedScopes,
  requireAccessToken,
  scopeFlags,
  startResumableUpload,
} from "./google";
import {
  errorResponse,
  escapeHtml,
  html,
  HttpError,
  json,
  readCookie,
  readJson,
  sameOrigin,
  wantsHtml,
} from "./http";
import {
  jobForApi,
  jobsForApi,
  ownerReconcile,
  reconcileOpenJobs,
  reportFromAgent,
  startJob,
  thresholdsFor,
  webhookMap,
} from "./jobs";
import { configuredFolders, folderByKey, publicFolders } from "./privateConfig";
import { d1sql } from "./store";
import {
  clearLoginFailures,
  deleteCredential,
  deleteExpiredStates,
  getUpload,
  insertUpload,
  loginFailure,
  loginLocked,
  saveOauthState,
  takeOauthState,
  updateUpload,
} from "./store";

const PUBLIC_PATHS = new Set(["/", "/index.html", "/site.css", "/favicon.svg", "/robots.txt"]);

const PUBLIC_CSP =
  "default-src 'self'; style-src 'self'; img-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

const DESK_CSP = [
  "default-src 'self'",
  "script-src 'self' https://apis.google.com https://accounts.google.com",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'self' https://apis.google.com https://www.googleapis.com",
  "frame-src https://accounts.google.com https://docs.google.com https://drive.google.com",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export interface HandlerDeps {
  fetch?: typeof fetch;
  now?: () => number;
}

export function createHandler(deps: HandlerDeps = {}): (request: Request, env: Env) => Promise<Response> {
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? (() => Date.now());
  return async (request, env) => {
    try {
      return await dispatch(request, env, fetchImpl, now());
    } catch (error) {
      if (error instanceof HttpResponseError) return error.response;
      if (error instanceof Redirect) return redirect(error.location);
      if (error instanceof HttpError) return errorResponse(error);
      console.error("automate_error", sanitizeMessage(error instanceof Error ? error.message : "unknown"));
      return json({ error: "internal" }, 500);
    }
  };
}

async function dispatch(request: Request, env: Env, fetchImpl: typeof fetch, nowMs: number): Promise<Response> {
  const url = new URL(request.url);
  const path = normalizePath(url.pathname);
  if (request.method === "OPTIONS") return new Response(null, { status: 405 });
  if (PUBLIC_PATHS.has(path)) return servePublic(request, env, path);

  const report = path.match(/^\/api\/automate\/jobs\/([0-9a-f-]{16,80})\/report$/);
  if (report && request.method === "POST") {
    return handleReport(request, env, report[1] ?? "", nowMs);
  }
  if (path === "/favicon.ico" && request.method === "GET") return servePublic(request, env, "/favicon.svg");
  if (!path.startsWith("/automate") && !path.startsWith("/api/automate")) {
    return plainAuthPage("Not found", "That page is not on this site.", 404);
  }
  if (path === "/automate/login" && request.method === "GET") return loginPage(request, env, null);
  if (path === "/api/automate/session" && request.method === "POST") return login(request, env, nowMs);
  if (path === "/api/automate/session" && request.method === "DELETE") {
    const identity = await requireIdentity(request, env, fetchImpl, nowMs);
    assertMutation(request);
    return withCookies(json({ ok: true, auth: identity.mode }), [clearSessionCookie(request)]);
  }

  const identity = await gate(request, env, fetchImpl, nowMs, path);
  const csrf = ensureCsrf(request);
  if (request.method !== "GET" && request.method !== "HEAD") assertMutation(request);

  if (path === "/api/automate/bootstrap" && request.method === "GET") {
    return withCookies(json(await bootstrap(env, identity, nowMs)), csrfSet(request, csrf));
  }
  if (path === "/api/automate/jobs" && request.method === "GET") {
    const agent = url.searchParams.get("agent");
    const jobs = await jobsForApi(d1sql(env.DB), agent, nowMs, thresholdsFor(env));
    return json({ jobs });
  }
  if (path === "/api/automate/jobs" && request.method === "POST") {
    const body = asRecord(await readJson(request));
    const result = await startJob({
      sql: d1sql(env.DB),
      env,
      fetchImpl,
      agent: String(body?.agent ?? ""),
      task: String(body?.task ?? ""),
      idempotencyKey: String(body?.idempotencyKey ?? ""),
      nowMs,
    });
    return json(result, result.created ? 201 : 200);
  }
  if (path === "/api/automate/jobs/reconcile" && request.method === "POST") {
    const result = await reconcileOpenJobs({ sql: d1sql(env.DB), env, fetchImpl, nowMs });
    return json(result);
  }
  const jobAction = path.match(/^\/api\/automate\/jobs\/([0-9a-f-]{16,80})(?:\/(reconcile))?$/);
  if (jobAction && request.method === "GET" && !jobAction[2]) {
    return json({ job: await jobForApi(d1sql(env.DB), jobAction[1] ?? "", nowMs, thresholdsFor(env)) });
  }
  if (jobAction?.[2] === "reconcile" && request.method === "POST") {
    const result = await ownerReconcile({
      sql: d1sql(env.DB),
      env,
      fetchImpl,
      id: jobAction[1] ?? "",
      body: await readJson(request),
      nowMs,
    });
    return json(result);
  }
  if (path === "/api/automate/google/start" && request.method === "POST") {
    return json(await beginGoogle(env, nowMs));
  }
  if (path === "/api/automate/google/callback" && request.method === "GET") {
    return finishGoogle(request, env, fetchImpl, nowMs);
  }
  if (path === "/api/automate/google/disconnect" && request.method === "POST") {
    await deleteCredential(d1sql(env.DB));
    return json({ ok: true });
  }
  if (path === "/api/automate/google/picker-token" && request.method === "GET") {
    const token = await requireAccessToken(d1sql(env.DB), env, fetchImpl, nowMs);
    return json({ accessToken: token.accessToken });
  }
  if (path === "/api/automate/drive/list" && request.method === "GET") {
    return json(await listFolder(env, fetchImpl, url, nowMs));
  }
  if (path === "/api/automate/drive/open" && request.method === "POST") {
    const body = asRecord(await readJson(request));
    const folderId = String(body?.folderId ?? "");
    if (!isDriveId(folderId)) throw new HttpError(400, "bad_folder");
    const token = await requireAccessToken(d1sql(env.DB), env, fetchImpl, nowMs);
    const allowed = await folderIsAllowed(fetchImpl, token.accessToken, env, folderId);
    const known = configuredFolders(env).find((folder) => folder.key === allowed.key);
    return json({ folderId: allowed.id, folderKey: allowed.key, label: known?.label ?? "Folder", upload: true });
  }
  const media = path.match(/^\/api\/automate\/drive\/files\/([a-zA-Z0-9_-]+)\/(thumb|preview)$/);
  if (media && request.method === "GET") {
    return driveMedia(env, fetchImpl, media[1] ?? "", media[2] === "preview", nowMs);
  }
  if (path === "/api/automate/drive/uploads" && request.method === "POST") {
    return startUpload(request, env, fetchImpl, nowMs);
  }
  const upload = path.match(/^\/api\/automate\/drive\/uploads\/([0-9a-f-]{16,80})(\/retry)?$/);
  if (upload && request.method === "PUT" && !upload[2]) {
    return receiveChunk(request, env, fetchImpl, upload[1] ?? "", nowMs);
  }
  if (upload?.[2] === "/retry" && request.method === "POST") {
    return retryUpload(env, fetchImpl, upload[1] ?? "", nowMs);
  }

  if (request.method === "GET" && (path === "/automate/app.js" || path === "/automate/app.css" || path === "/automate/index.html")) {
    return withCookies(await serveDeskAsset(request, env, path), csrfSet(request, csrf));
  }
  if (request.method === "GET" && isDeskPage(path)) {
    return withCookies(await serveDeskAsset(request, env, "/automate/index.html"), csrfSet(request, csrf));
  }
  if (wantsHtml(request)) return plainAuthPage("Not found", "That page is not on this site.", 404);
  return json({ error: "not_found" }, 404);
}

function normalizePath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.slice(0, -1);
  return pathname;
}

function isDeskPage(path: string): boolean {
  if (path === "/automate" || path === "/automate/drive") return true;
  const match = path.match(/^\/automate\/agents\/([a-z]+)$/);
  if (!match) return false;
  return AGENTS.some((agent) => agent.slug === match[1]);
}

async function gate(
  request: Request,
  env: Env,
  fetchImpl: typeof fetch,
  nowMs: number,
  path: string,
): Promise<Identity> {
  try {
    return await requireIdentity(request, env, fetchImpl, nowMs);
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    if (request.method === "GET" && wantsHtml(request) && path.startsWith("/automate")) {
      if (error.status === 401 && devAuthEnabled(env, request)) {
        throw new Redirect("/automate/login");
      }
      const page = plainAuthPage(
        error.status === 503 ? "Setup needed" : "Sign in required",
        error.detail ?? "This desk is private.",
        error.status,
      );
      throw new HttpResponseError(page);
    }
    throw error;
  }
}

class Redirect extends Error {
  constructor(readonly location: string) {
    super("redirect");
  }
}

class HttpResponseError extends Error {
  constructor(readonly response: Response) {
    super("response");
  }
}

async function handleReport(request: Request, env: Env, id: string, nowMs: number): Promise<Response> {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  if (!token) throw new HttpError(401, "unauthorized");
  const job = await reportFromAgent({ sql: d1sql(env.DB), id, token, body: await readJson(request), nowMs });
  return json({ job });
}

function loginPage(request: Request, env: Env, message: string | null): Response {
  const mode = authConfigured(env, request);
  if (mode === "access") {
    return plainAuthPage(
      "Use Cloudflare Access",
      "This desk checks a Cloudflare Access token on every request. Open it through the protected hostname.",
      401,
    );
  }
  if (mode === "unconfigured") {
    return plainAuthPage(
      "Setup needed",
      "Owner sign-in is not configured. The setup guide names the Access variables and the local-only dev variables.",
      503,
    );
  }
  const token = readCookie(request, CSRF_COOKIE) ?? issueCsrf();
  const cookie = readCookie(request, CSRF_COOKIE) ? null : csrfCookie(request, token);
  const error = message ? `<p class="err">${escapeHtml(message)}</p>` : "";
  const page = html(
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sign in · Automate</title>
</head>
<body style="margin:0;background:#12100c;color:#f4efe6;font-family:Georgia,serif">
  <main style="max-width:28rem;margin:10vh auto;padding:0 1.25rem">
    <p style="letter-spacing:.16em;text-transform:uppercase;font-family:sans-serif;font-size:.72rem;color:#e4b15a">Private desk</p>
    <h1 style="font-weight:500;font-size:2.6rem;margin:.2rem 0 .4rem">Automate</h1>
    <p style="font-family:sans-serif;color:#d9d0c3;line-height:1.5">Local sign-in for this machine. Production uses Cloudflare Access.</p>
    ${error}
    <form method="post" action="/api/automate/session" style="display:grid;gap:.75rem;margin-top:1.5rem">
      <input type="hidden" name="csrf" value="${escapeHtml(token)}">
      <label style="font-family:sans-serif;font-size:.9rem">Password
        <input name="password" type="password" autocomplete="current-password" required style="display:block;width:100%;margin-top:.35rem;padding:.7rem .8rem;border-radius:10px;border:1px solid #4a4034;background:#1c1914;color:#f4efe6">
      </label>
      <button style="font-family:sans-serif;background:#e4b15a;color:#1c1408;border:0;border-radius:999px;padding:.75rem 1rem;font-weight:700">Enter</button>
    </form>
    <p style="font-family:sans-serif"><a href="/" style="color:#e4b15a">Public site</a></p>
  </main>
</body>
</html>`,
    message ? 401 : 200,
  );
  return cookie ? withCookies(page, [cookie]) : page;
}

async function login(request: Request, env: Env, nowMs: number): Promise<Response> {
  if (!devAuthEnabled(env, request)) throw new HttpError(404, "not_found");
  const sql = d1sql(env.DB);
  const form = await readLoginBody(request);
  assertMutation(request, form.csrf);
  if (await loginLocked(sql, nowMs)) {
    throw new HttpError(429, "locked", { detail: "Too many sign-in attempts. Wait and try again." });
  }
  try {
    const token = await establishDevSession(form.password, env, request);
    await clearLoginFailures(sql);
    const cookies = [sessionCookie(request, token), csrfCookie(request, issueCsrf())];
    if (form.kind === "form") {
      return withCookies(redirect("/automate", 303), cookies);
    }
    return withCookies(json({ ok: true }), cookies);
  } catch (error) {
    if (error instanceof HttpError && error.status === 401) {
      const lock = await loginFailure(sql, nowMs);
      if (lock.locked) {
        const locked = new HttpError(429, "locked", { detail: "Too many sign-in attempts. Wait and try again." });
        if (form.kind === "form") return loginPage(request, env, locked.detail ?? "Locked.");
        throw locked;
      }
      if (form.kind === "form") return loginPage(request, env, "That password was not accepted.");
    }
    throw error;
  }
}

async function readLoginBody(request: Request): Promise<{ kind: "json" | "form"; password: string; csrf: string | null }> {
  const type = request.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const body = asRecord(await readJson(request));
    return { kind: "json", password: String(body?.password ?? ""), csrf: null };
  }
  const form = await request.formData();
  return {
    kind: "form",
    password: String(form.get("password") ?? ""),
    csrf: typeof form.get("csrf") === "string" ? String(form.get("csrf")) : null,
  };
}

async function bootstrap(env: Env, identity: Identity, _nowMs: number) {
  const sql = d1sql(env.DB);
  const google = await connectionSummary(sql);
  const flags = scopeFlags(google.scopes);
  const thresholds = thresholdsFor(env);
  return {
    auth: identity.mode,
    ownerEmail: identity.email,
    agents: AGENTS.map((agent) => ({
      slug: agent.slug,
      name: agent.name,
      stamp: agent.stamp,
      role: agent.role,
      group: agent.group,
      summary: agent.summary,
      boundary: agent.boundary,
      tasks: agent.tasks.map((task) => ({
        key: task.key,
        label: task.label,
        detail: task.detail,
        kind: task.kind,
      })),
    })),
    setup: {
      google: google.connected ? "connected" : "setup_needed",
      googleEmail: google.email,
      googleOauth: googleOauthConfigured(env),
      encryption: encryptionReady(env.TOKEN_ENCRYPTION_KEY),
      scopes: flags,
      webhooks: webhookMap(env),
      slackSheet: Boolean(env.SLACK_LOG_SHEET_ID && isDriveId(env.SLACK_LOG_SHEET_ID)),
      slackFolders: {
        postr: Boolean(env.SLACK_FOLDER_POSTR && isDriveId(env.SLACK_FOLDER_POSTR)),
        ready: Boolean(env.SLACK_FOLDER_READY && isDriveId(env.SLACK_FOLDER_READY)),
        posted: Boolean(env.SLACK_FOLDER_POSTED && isDriveId(env.SLACK_FOLDER_POSTED)),
      },
      picker: Boolean(env.GOOGLE_PICKER_API_KEY && env.GOOGLE_CLOUD_PROJECT_NUMBER),
      publicBaseUrl: Boolean(publicCallbackConfigured(env)),
    },
    picker:
      env.GOOGLE_PICKER_API_KEY && env.GOOGLE_CLOUD_PROJECT_NUMBER
        ? { apiKey: env.GOOGLE_PICKER_API_KEY, appId: env.GOOGLE_CLOUD_PROJECT_NUMBER }
        : null,
    folders: publicFolders(env),
    stale: {
      requestedMinutes: Math.round(thresholds.requested / 60000),
      runningMinutes: Math.round(thresholds.running / 60000),
    },
  };
}

function publicCallbackConfigured(env: Env): boolean {
  const base = env.PUBLIC_BASE_URL?.trim();
  if (!base) return false;
  try {
    const url = new URL(base);
    return url.protocol === "https:" && !url.username && !url.password && (url.pathname === "/" || url.pathname === "");
  } catch {
    return false;
  }
}

async function beginGoogle(env: Env, nowMs: number): Promise<{ url: string }> {
  if (!googleOauthConfigured(env) || !env.TOKEN_ENCRYPTION_KEY) {
    throw new HttpError(409, "setup_needed", {
      integration: "google_oauth",
      detail: "Google OAuth client variables are not complete.",
    });
  }
  const scopes = requestedScopes(env);
  if (!scopes) {
    throw new HttpError(409, "setup_needed", {
      integration: "google_oauth",
      detail: "GOOGLE_OAUTH_SCOPES contains a scope this desk will not request.",
    });
  }
  const sql = d1sql(env.DB);
  await deleteExpiredStates(sql, new Date(nowMs - 10 * 60 * 1000).toISOString());
  const state = randomToken(24);
  const verifier = randomToken(32);
  await saveOauthState(sql, state, await encryptString(env.TOKEN_ENCRYPTION_KEY, verifier), new Date(nowMs).toISOString());
  const challenge = await codeChallenge(verifier);
  const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  auth.searchParams.set("client_id", env.GOOGLE_OAUTH_CLIENT_ID ?? "");
  auth.searchParams.set("redirect_uri", env.GOOGLE_OAUTH_REDIRECT_URL ?? "");
  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("scope", scopes.join(" "));
  auth.searchParams.set("state", state);
  auth.searchParams.set("code_challenge", challenge);
  auth.searchParams.set("code_challenge_method", "S256");
  auth.searchParams.set("access_type", "offline");
  auth.searchParams.set("prompt", "consent");
  auth.searchParams.set("include_granted_scopes", "true");
  return { url: auth.toString() };
}

async function finishGoogle(request: Request, env: Env, fetchImpl: typeof fetch, nowMs: number): Promise<Response> {
  const url = new URL(request.url);
  if (url.searchParams.get("error")) return redirect("/automate/drive?google=denied");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state || !env.TOKEN_ENCRYPTION_KEY) return redirect("/automate/drive?google=error");
  const sql = d1sql(env.DB);
  const saved = await takeOauthState(sql, state);
  if (!saved) return redirect("/automate/drive?google=state");
  if (nowMs - Date.parse(saved.created_at) > 10 * 60 * 1000) return redirect("/automate/drive?google=state");
  const verifier = await decryptString(env.TOKEN_ENCRYPTION_KEY, saved.code_verifier_enc);
  if (!verifier) return redirect("/automate/drive?google=error");
  try {
    await exchangeCode(sql, env, fetchImpl, code, verifier, nowMs);
  } catch (error) {
    console.error("google_callback", sanitizeMessage(error instanceof Error ? error.message : "unknown"));
    return redirect("/automate/drive?google=error");
  }
  return redirect("/automate/drive?google=connected");
}

async function listFolder(env: Env, fetchImpl: typeof fetch, url: URL, nowMs: number) {
  const key = url.searchParams.get("key");
  const requestedId = url.searchParams.get("folderId");
  const pageToken = url.searchParams.get("pageToken");
  if (pageToken && (pageToken.length > 1024 || /[\u0000-\u001f]/.test(pageToken))) {
    throw new HttpError(400, "bad_page");
  }
  const token = await requireAccessToken(d1sql(env.DB), env, fetchImpl, nowMs);
  let folderId = "";
  let label = "Folder";
  if (key) {
    const folder = folderByKey(env, key);
    if (!folder) {
      throw new HttpError(409, "setup_needed", {
        integration: "slack_folder",
        detail: "That Slack folder id is not configured.",
      });
    }
    folderId = folder.id;
    label = folder.label;
  } else if (requestedId && isDriveId(requestedId)) {
    const allowed = await folderIsAllowed(fetchImpl, token.accessToken, env, requestedId);
    folderId = allowed.id;
    label = configuredFolders(env).find((folder) => folder.key === allowed.key)?.label ?? "Folder";
  } else {
    throw new HttpError(400, "bad_folder");
  }
  const listed = await listDriveFolder(fetchImpl, token.accessToken, folderId, pageToken);
  const breadcrumb = await crumbs(fetchImpl, token.accessToken, env, folderId);
  return { label, folderId, items: listed.items, nextPageToken: listed.nextPageToken, breadcrumb };
}

async function crumbs(
  fetchImpl: typeof fetch,
  accessToken: string,
  env: Env,
  folderId: string,
): Promise<Array<{ id: string; name: string }>> {
  const chain: Array<{ id: string; name: string }> = [];
  let current = folderId;
  for (let depth = 0; depth < 6; depth += 1) {
    const meta = await getDriveFile(fetchImpl, accessToken, current);
    chain.push({ id: meta.id, name: meta.name });
    const parent = meta.parents[0];
    if (!parent) break;
    if (configuredFolders(env).some((folder) => folder.id === meta.id) && depth > 0) break;
    if (configuredFolders(env).some((folder) => folder.id === parent)) {
      const root = await getDriveFile(fetchImpl, accessToken, parent);
      chain.push({ id: root.id, name: root.name });
      break;
    }
    current = parent;
  }
  return chain.reverse();
}

async function driveMedia(
  env: Env,
  fetchImpl: typeof fetch,
  fileId: string,
  preview: boolean,
  nowMs: number,
): Promise<Response> {
  const token = await requireAccessToken(d1sql(env.DB), env, fetchImpl, nowMs);
  const meta = await getDriveFile(fetchImpl, token.accessToken, fileId);
  if (!meta.mimeType.startsWith("image/")) throw new HttpError(415, "unsupported_type");
  await folderIsAllowed(fetchImpl, token.accessToken, env, fileId);
  const media = await downloadThumbnail(fetchImpl, token.accessToken, meta, preview ? 8 * 1024 * 1024 : 2 * 1024 * 1024);
  if (!media.contentType.startsWith("image/")) throw new HttpError(502, "drive_media");
  return new Response(media.bytes, {
    headers: {
      "content-type": media.contentType,
      "cache-control": "private, max-age=300",
      "x-content-type-options": "nosniff",
      "content-disposition": "inline",
    },
  });
}

async function startUpload(request: Request, env: Env, fetchImpl: typeof fetch, nowMs: number): Promise<Response> {
  const body = asRecord(await readJson(request));
  const image = validateImage(body);
  const sql = d1sql(env.DB);
  const token = await requireAccessToken(sql, env, fetchImpl, nowMs);
  const destination = await resolveDestination(env, fetchImpl, token.accessToken, body);
  if (!env.TOKEN_ENCRYPTION_KEY) {
    throw new HttpError(409, "setup_needed", { integration: "encryption" });
  }
  const id = crypto.randomUUID();
  const now = new Date(nowMs).toISOString();
  await insertUpload(sql, {
    id,
    folderId: destination.id,
    folderKey: destination.key,
    fileName: image.name,
    mimeType: image.mimeType,
    sizeBytes: image.size,
    now,
  });
  try {
    const location = await startResumableUpload(
      fetchImpl,
      token.accessToken,
      destination.id,
      image.name,
      image.mimeType,
      image.size,
    );
    await updateUpload(sql, id, {
      sessionUriEnc: await encryptString(env.TOKEN_ENCRYPTION_KEY, location),
      status: "uploading",
      error: null,
      now,
    });
  } catch (error) {
    const detail = error instanceof HttpError ? error.detail ?? error.code : "upload_failed";
    await updateUpload(sql, id, { status: "failed", error: sanitizeMessage(detail), now });
    throw error;
  }
  return json(
    { uploadId: id, chunkSize: UPLOAD_CHUNK_BYTES, received: 0, total: image.size, status: "uploading" },
    201,
  );
}

async function receiveChunk(
  request: Request,
  env: Env,
  fetchImpl: typeof fetch,
  id: string,
  nowMs: number,
): Promise<Response> {
  const sql = d1sql(env.DB);
  const upload = await getUpload(sql, id);
  if (!upload) throw new HttpError(404, "not_found");
  if (upload.status === "complete") {
    return json({
      uploadId: id,
      received: upload.size_bytes,
      total: upload.size_bytes,
      status: "complete",
      fileId: upload.drive_file_id,
      webViewLink: upload.web_view_link,
    });
  }
  const range = parseRange(request.headers.get("content-range"), upload.size_bytes);
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > UPLOAD_CHUNK_BYTES) throw new HttpError(413, "too_large");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength !== range.end - range.start + 1) throw new HttpError(400, "bad_range");
  if (range.start !== upload.received_bytes) {
    if (range.end < upload.received_bytes) {
      return json({ uploadId: id, received: upload.received_bytes, total: upload.size_bytes, status: upload.status });
    }
    throw new HttpError(409, "upload_conflict", { detail: "The chunk does not continue from the last received byte." });
  }
  if (!upload.session_uri_enc || !env.TOKEN_ENCRYPTION_KEY) {
    throw new HttpError(409, "upload_restart", { extra: { restart: true } });
  }
  const sessionUri = await decryptString(env.TOKEN_ENCRYPTION_KEY, upload.session_uri_enc);
  if (!sessionUri) throw new HttpError(409, "upload_restart", { extra: { restart: true } });
  const now = new Date(nowMs).toISOString();
  try {
    const result = await putUploadChunk(fetchImpl, sessionUri, bytes, range.start, range.end, range.total);
    if (result.status === 200 || result.status === 201) {
      const fileId = result.file?.id && isDriveId(result.file.id) ? result.file.id : null;
      const link = safeLink(result.file?.webViewLink, fileId);
      await updateUpload(sql, id, {
        received: upload.size_bytes,
        status: "complete",
        error: null,
        driveFileId: fileId,
        webViewLink: link,
        now,
      });
      return json({
        uploadId: id,
        received: upload.size_bytes,
        total: upload.size_bytes,
        status: "complete",
        fileId,
        webViewLink: link,
      });
    }
    const received = result.received ?? range.end + 1;
    await updateUpload(sql, id, { received, status: "uploading", error: null, now });
    return json({ uploadId: id, received, total: upload.size_bytes, status: "uploading" });
  } catch (error) {
    if (error instanceof HttpError) {
      await updateUpload(sql, id, { status: "failed", error: sanitizeMessage(error.detail ?? error.code), now });
    }
    throw error;
  }
}

async function retryUpload(env: Env, fetchImpl: typeof fetch, id: string, nowMs: number): Promise<Response> {
  const sql = d1sql(env.DB);
  const upload = await getUpload(sql, id);
  if (!upload) throw new HttpError(404, "not_found");
  if (!upload.session_uri_enc || !env.TOKEN_ENCRYPTION_KEY) {
    return json({ uploadId: id, restart: true, received: 0, total: upload.size_bytes, status: "failed" });
  }
  const sessionUri = await decryptString(env.TOKEN_ENCRYPTION_KEY, upload.session_uri_enc);
  if (!sessionUri) return json({ uploadId: id, restart: true, received: 0, total: upload.size_bytes, status: "failed" });
  try {
    const probe = await probeUpload(fetchImpl, sessionUri, upload.size_bytes);
    const now = new Date(nowMs).toISOString();
    await updateUpload(sql, id, { received: probe.received, status: "uploading", error: null, now });
    return json({
      uploadId: id,
      restart: false,
      received: probe.received,
      total: upload.size_bytes,
      status: probe.received >= upload.size_bytes ? "complete" : "uploading",
    });
  } catch (error) {
    if (error instanceof HttpError && error.code === "upload_restart") {
      await updateUpload(sql, id, {
        status: "failed",
        sessionUriEnc: null,
        error: "The upload session expired.",
        now: new Date(nowMs).toISOString(),
      });
      return json({ uploadId: id, restart: true, received: upload.received_bytes, total: upload.size_bytes, status: "failed" });
    }
    throw error;
  }
}

async function resolveDestination(
  env: Env,
  fetchImpl: typeof fetch,
  accessToken: string,
  body: Record<string, unknown> | null,
): Promise<{ id: string; key: string }> {
  const folderKey = typeof body?.folderKey === "string" ? body.folderKey : "";
  const folderId = typeof body?.folderId === "string" ? body.folderId : "";
  if (folderKey) {
    const folder = folderByKey(env, folderKey);
    if (!folder) {
      throw new HttpError(409, "setup_needed", {
        integration: "slack_folder",
        detail: "That folder is not configured on the allowlist.",
      });
    }
    return { id: folder.id, key: folder.key };
  }
  if (folderId && isDriveId(folderId)) {
    const allowed = await folderIsAllowed(fetchImpl, accessToken, env, folderId);
    return { id: allowed.id, key: allowed.key };
  }
  throw new HttpError(400, "bad_folder");
}

function validateImage(body: Record<string, unknown> | null): { name: string; mimeType: string; size: number } {
  const mimeType = typeof body?.mimeType === "string" ? body.mimeType : "";
  if (!IMAGE_MIME_TYPES.includes(mimeType as (typeof IMAGE_MIME_TYPES)[number])) {
    throw new HttpError(400, "unsupported_type", { detail: "Upload jpeg, png, webp, or gif photos." });
  }
  const size = body?.size;
  if (typeof size !== "number" || !Number.isInteger(size) || size <= 0 || size > MAX_UPLOAD_BYTES) {
    throw new HttpError(400, "bad_size", { detail: "Each photo must be between 1 byte and 30 MB." });
  }
  const name = typeof body?.name === "string" ? safeFileName(body.name) : null;
  if (!name) throw new HttpError(400, "bad_name");
  return { name, mimeType, size };
}

function safeFileName(name: string): string | null {
  const base = name.split(/[/\\]/).pop()?.trim() ?? "";
  if (!base || base.length > 180 || base === "." || base === "..") return null;
  if (/[\u0000-\u001f]/.test(base)) return null;
  return base;
}

function parseRange(header: string | null, totalExpected: number): { start: number; end: number; total: number } {
  const match = header?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
  if (!match) throw new HttpError(400, "bad_range");
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (total !== totalExpected || end < start || end >= total) throw new HttpError(400, "bad_range");
  const length = end - start + 1;
  if (length > UPLOAD_CHUNK_BYTES) throw new HttpError(400, "bad_range");
  const isLast = end === total - 1;
  if (!isLast && length % DRIVE_CHUNK_MULTIPLE !== 0) throw new HttpError(400, "bad_range");
  return { start, end, total };
}

function safeLink(link: string | undefined, fileId: string | null): string | null {
  if (link) {
    try {
      const url = new URL(link);
      if (url.protocol === "https:" && (url.hostname === "drive.google.com" || url.hostname === "docs.google.com")) {
        return url.toString();
      }
    } catch {
      return fileId ? `https://drive.google.com/file/d/${fileId}/view` : null;
    }
  }
  return fileId ? `https://drive.google.com/file/d/${fileId}/view` : null;
}

async function servePublic(request: Request, env: Env, path: string): Promise<Response> {
  const assetPath = path === "/" ? "/index.html" : path;
  const response = await env.ASSETS.fetch(new Request(new URL(assetPath, request.url)));
  return stamp(response, PUBLIC_CSP, false);
}

async function serveDeskAsset(request: Request, env: Env, assetPath: string): Promise<Response> {
  const response = await env.ASSETS.fetch(new Request(new URL(assetPath, request.url)));
  return stamp(response, DESK_CSP, true);
}

function stamp(response: Response, csp: string, desk: boolean): Response {
  const headers = new Headers(response.headers);
  headers.set("content-security-policy", csp);
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("referrer-policy", "strict-origin-when-cross-origin");
  if (desk) {
    headers.set("cache-control", "no-store");
    headers.set("x-robots-tag", "noindex, nofollow");
  }
  return new Response(response.body, { status: response.status, headers });
}

function assertMutation(request: Request, formToken?: string | null): void {
  if (!sameOrigin(request)) throw new HttpError(403, "csrf");
  assertCsrf(request, formToken);
}

function ensureCsrf(request: Request): { token: string; fresh: boolean } {
  const existing = readCookie(request, CSRF_COOKIE);
  if (existing) return { token: existing, fresh: false };
  return { token: issueCsrf(), fresh: true };
}

function csrfSet(request: Request, csrf: { token: string; fresh: boolean }): string[] {
  if (!csrf.fresh) return [];
  return [csrfCookie(request, csrf.token)];
}

function withCookies(response: Response, cookies: string[]): Response {
  if (cookies.length === 0) return response;
  const headers = new Headers(response.headers);
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function redirect(location: string, status = 302): Response {
  if (!location.startsWith("/automate")) throw new HttpError(400, "bad_redirect");
  return new Response(null, { status, headers: { location, "cache-control": "no-store" } });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
