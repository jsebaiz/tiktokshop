import { SHEET_COLUMNS, SHEET_TAB, type AgentSlug } from "../shared/catalog";
import { isDriveId } from "../shared/urls";
import { decryptString, encryptString, encryptionReady } from "./crypto";
import type { Env } from "./env";
import { HttpError, isRedirect, safeFetch } from "./http";
import { folderById, TRACKER_SHEET_ID } from "./privateConfig";
import {
  getCredential,
  saveCredential,
  updateAccessToken,
  type CredentialRow,
  type Sql,
} from "./store";

export const SCOPE_ALLOWLIST = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/spreadsheets.readonly",
] as const;

const DEFAULT_SCOPES = ["openid", "email", "https://www.googleapis.com/auth/drive.file"];

export interface GoogleConnection {
  email: string | null;
  scopes: string[];
  accessToken: string;
}

export function requestedScopes(env: Env): string[] | null {
  const raw = env.GOOGLE_OAUTH_SCOPES?.trim();
  const scopes = raw ? raw.split(/\s+/) : DEFAULT_SCOPES;
  if (scopes.some((scope) => !SCOPE_ALLOWLIST.includes(scope as (typeof SCOPE_ALLOWLIST)[number]))) return null;
  if (!scopes.includes("openid") || !scopes.includes("email")) return null;
  return scopes;
}

export function googleOauthConfigured(env: Env): boolean {
  return Boolean(
    encryptionReady(env.TOKEN_ENCRYPTION_KEY) &&
      env.GOOGLE_OAUTH_CLIENT_ID &&
      env.GOOGLE_OAUTH_CLIENT_SECRET &&
      env.GOOGLE_OAUTH_REDIRECT_URL &&
      requestedScopes(env),
  );
}

export function scopeFlags(scopes: string[]): {
  driveFile: boolean;
  driveReadonly: boolean;
  drive: boolean;
  sheetsReadonly: boolean;
} {
  return {
    driveFile: scopes.includes("https://www.googleapis.com/auth/drive.file") || scopes.includes("https://www.googleapis.com/auth/drive"),
    driveReadonly:
      scopes.includes("https://www.googleapis.com/auth/drive.readonly") ||
      scopes.includes("https://www.googleapis.com/auth/drive"),
    drive: scopes.includes("https://www.googleapis.com/auth/drive"),
    sheetsReadonly:
      scopes.includes("https://www.googleapis.com/auth/spreadsheets.readonly") ||
      scopes.includes("https://www.googleapis.com/auth/drive"),
  };
}

export async function connectionSummary(
  sql: Sql,
): Promise<{ connected: boolean; email: string | null; scopes: string[] }> {
  const row = await getCredential(sql);
  if (!row) return { connected: false, email: null, scopes: [] };
  return { connected: true, email: row.email, scopes: row.scopes.split(/\s+/).filter(Boolean) };
}

export async function requireAccessToken(
  sql: Sql,
  env: Env,
  fetchImpl: typeof fetch,
  nowMs: number,
): Promise<GoogleConnection> {
  if (!encryptionReady(env.TOKEN_ENCRYPTION_KEY) || !env.TOKEN_ENCRYPTION_KEY) {
    throw new HttpError(409, "setup_needed", {
      integration: "encryption",
      detail: "TOKEN_ENCRYPTION_KEY is not configured, so stored Google credentials cannot be used.",
    });
  }
  const row = await getCredential(sql);
  if (!row) {
    throw new HttpError(409, "setup_needed", {
      integration: "google",
      detail: "Google is not connected.",
    });
  }
  const scopes = row.scopes.split(/\s+/).filter(Boolean);
  const expiry = row.access_expires_at ? Date.parse(row.access_expires_at) : 0;
  if (row.access_token_enc && expiry - 60_000 > nowMs) {
    const accessToken = await decryptString(env.TOKEN_ENCRYPTION_KEY, row.access_token_enc);
    if (accessToken) return { email: row.email, scopes, accessToken };
  }
  return refreshAccessToken(sql, env, fetchImpl, row, nowMs);
}

async function refreshAccessToken(
  sql: Sql,
  env: Env,
  fetchImpl: typeof fetch,
  row: CredentialRow,
  nowMs: number,
): Promise<GoogleConnection> {
  if (!env.TOKEN_ENCRYPTION_KEY || !env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET) {
    throw new HttpError(409, "setup_needed", { integration: "google_oauth" });
  }
  const refreshToken = await decryptString(env.TOKEN_ENCRYPTION_KEY, row.refresh_token_enc);
  if (!refreshToken) {
    throw new HttpError(409, "setup_needed", {
      integration: "google",
      detail: "The stored Google credential could not be read. Connect Google again.",
    });
  }
  const body = new URLSearchParams({
    client_id: env.GOOGLE_OAUTH_CLIENT_ID,
    client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const response = await safeFetch(
    fetchImpl,
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    },
    { hosts: ["oauth2.googleapis.com"], path: /^\/token$/ },
  );
  if (isRedirect(response.status) || response.status !== 200) {
    throw new HttpError(409, "setup_needed", {
      integration: "google",
      detail: "Google did not refresh the connection. Connect Google again.",
    });
  }
  const parsed = (await response.json()) as { access_token?: string; expires_in?: number; scope?: string };
  if (!parsed.access_token) {
    throw new HttpError(409, "setup_needed", { integration: "google", detail: "Google returned no access token." });
  }
  const scopes = (parsed.scope ?? row.scopes).split(/\s+/).filter(Boolean);
  const expiresAt = new Date(nowMs + (parsed.expires_in ?? 3600) * 1000).toISOString();
  const enc = await encryptString(env.TOKEN_ENCRYPTION_KEY, parsed.access_token);
  await updateAccessToken(sql, enc, expiresAt, scopes.join(" "), new Date(nowMs).toISOString());
  return { email: row.email, scopes, accessToken: parsed.access_token };
}

export async function exchangeCode(
  sql: Sql,
  env: Env,
  fetchImpl: typeof fetch,
  code: string,
  verifier: string,
  nowMs: number,
): Promise<void> {
  if (!googleOauthConfigured(env) || !env.TOKEN_ENCRYPTION_KEY) {
    throw new HttpError(409, "setup_needed", { integration: "google_oauth" });
  }
  const body = new URLSearchParams({
    code,
    client_id: env.GOOGLE_OAUTH_CLIENT_ID ?? "",
    client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET ?? "",
    redirect_uri: env.GOOGLE_OAUTH_REDIRECT_URL ?? "",
    grant_type: "authorization_code",
    code_verifier: verifier,
  });
  const response = await safeFetch(
    fetchImpl,
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    },
    { hosts: ["oauth2.googleapis.com"], path: /^\/token$/ },
  );
  if (isRedirect(response.status) || response.status !== 200) {
    throw new HttpError(502, "google_token", { detail: "Google did not accept the authorization code." });
  }
  const parsed = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  if (!parsed.access_token || !parsed.refresh_token) {
    throw new HttpError(409, "setup_needed", {
      integration: "google",
      detail: "Google did not return a refresh token. Reconnect and approve access.",
    });
  }
  const email = await fetchEmail(fetchImpl, parsed.access_token);
  const scopes = (parsed.scope ?? "").split(/\s+/).filter(Boolean);
  const now = new Date(nowMs).toISOString();
  await saveCredential(sql, {
    email,
    refreshTokenEnc: await encryptString(env.TOKEN_ENCRYPTION_KEY, parsed.refresh_token),
    accessTokenEnc: await encryptString(env.TOKEN_ENCRYPTION_KEY, parsed.access_token),
    accessExpiresAt: new Date(nowMs + (parsed.expires_in ?? 3600) * 1000).toISOString(),
    scopes: scopes.join(" "),
    updatedAt: now,
  });
}

async function fetchEmail(fetchImpl: typeof fetch, accessToken: string): Promise<string | null> {
  const response = await safeFetch(
    fetchImpl,
    "https://www.googleapis.com/oauth2/v3/userinfo",
    { headers: { authorization: `Bearer ${accessToken}` } },
    { hosts: ["www.googleapis.com"], path: /^\/oauth2\/v3\/userinfo$/ },
  );
  if (response.status !== 200) return null;
  const body = (await response.json()) as { email?: string };
  return typeof body.email === "string" ? body.email : null;
}

export async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export interface DriveItem {
  id: string;
  name: string;
  kind: "folder" | "image" | "file";
  mimeType: string;
  modifiedTime: string | null;
  size: number | null;
  thumb: boolean;
}

export async function listDriveFolder(
  fetchImpl: typeof fetch,
  accessToken: string,
  folderId: string,
  pageToken: string | null,
): Promise<{ items: DriveItem[]; nextPageToken: string | null }> {
  if (!isDriveId(folderId)) throw new HttpError(400, "bad_folder");
  const params = new URLSearchParams({
    q: `'${folderId}' in parents and trashed = false`,
    fields: "nextPageToken,files(id,name,mimeType,modifiedTime,size,thumbnailLink)",
    pageSize: "60",
    orderBy: "folder,name",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });
  if (pageToken) params.set("pageToken", pageToken);
  const response = await googleGet(
    fetchImpl,
    `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
    accessToken,
    /^\/drive\/v3\/files$/,
  );
  if (response.status === 403 || response.status === 404) {
    throw new HttpError(409, "setup_needed", {
      integration: "drive_browse",
      detail:
        "Google refused to list this folder. drive.file can upload into folders this app created or that you open with Google Picker. It cannot browse the existing Brands and Ready to Post trees. Add drive.readonly to GOOGLE_OAUTH_SCOPES and reconnect, or open the folder with Picker.",
    });
  }
  if (isRedirect(response.status) || response.status !== 200) {
    throw new HttpError(502, "drive_list", { detail: `Google Drive list failed (HTTP ${response.status}).` });
  }
  const body = (await response.json()) as {
    nextPageToken?: string;
    files?: Array<{
      id?: string;
      name?: string;
      mimeType?: string;
      modifiedTime?: string;
      size?: string;
      thumbnailLink?: string;
    }>;
  };
  const items: DriveItem[] = [];
  for (const file of body.files ?? []) {
    if (!file.id || !isDriveId(file.id) || !file.name || !file.mimeType) continue;
    const kind = file.mimeType === "application/vnd.google-apps.folder"
      ? "folder"
      : file.mimeType.startsWith("image/")
        ? "image"
        : "file";
    items.push({
      id: file.id,
      name: file.name,
      kind,
      mimeType: file.mimeType,
      modifiedTime: file.modifiedTime ?? null,
      size: file.size ? Number(file.size) : null,
      thumb: Boolean(file.thumbnailLink) || kind === "image",
    });
  }
  return { items, nextPageToken: body.nextPageToken ?? null };
}

export interface DriveFileMeta {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  size: number | null;
  thumbnailLink: string | null;
}

export async function getDriveFile(
  fetchImpl: typeof fetch,
  accessToken: string,
  fileId: string,
): Promise<DriveFileMeta> {
  if (!isDriveId(fileId)) throw new HttpError(400, "bad_file");
  const params = new URLSearchParams({
    fields: "id,name,mimeType,parents,size,thumbnailLink",
    supportsAllDrives: "true",
  });
  const response = await googleGet(
    fetchImpl,
    `https://www.googleapis.com/drive/v3/files/${fileId}?${params.toString()}`,
    accessToken,
    /^\/drive\/v3\/files\/[a-zA-Z0-9_-]+$/,
  );
  if (response.status === 403 || response.status === 404) {
    throw new HttpError(404, "not_found");
  }
  if (response.status !== 200) throw new HttpError(502, "drive_metadata");
  const body = (await response.json()) as {
    id?: string;
    name?: string;
    mimeType?: string;
    parents?: string[];
    size?: string;
    thumbnailLink?: string;
  };
  if (!body.id || !body.mimeType || !body.name) throw new HttpError(502, "drive_metadata");
  return {
    id: body.id,
    name: body.name,
    mimeType: body.mimeType,
    parents: (body.parents ?? []).filter((parent) => isDriveId(parent)),
    size: body.size ? Number(body.size) : null,
    thumbnailLink: body.thumbnailLink ?? null,
  };
}

export async function folderIsAllowed(
  fetchImpl: typeof fetch,
  accessToken: string,
  env: Env,
  folderId: string,
): Promise<{ key: string; id: string }> {
  const direct = folderById(env, folderId);
  if (direct) return { key: direct.key, id: direct.id };
  let current = folderId;
  for (let depth = 0; depth < 8; depth += 1) {
    const meta = await getDriveFile(fetchImpl, accessToken, current);
    if (meta.mimeType !== "application/vnd.google-apps.folder" && depth > 0) break;
    for (const parent of meta.parents) {
      const match = folderById(env, parent);
      if (match) return { key: match.key, id: folderId };
    }
    const next = meta.parents[0];
    if (!next) break;
    current = next;
  }
  throw new HttpError(403, "folder_not_allowlisted", {
    detail: "That folder is outside the allowlist for this desk.",
  });
}

export async function startResumableUpload(
  fetchImpl: typeof fetch,
  accessToken: string,
  folderId: string,
  name: string,
  mimeType: string,
  size: number,
): Promise<string> {
  const response = await safeFetch(
    fetchImpl,
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json; charset=UTF-8",
        "x-upload-content-type": mimeType,
        "x-upload-content-length": String(size),
      },
      body: JSON.stringify({ name, parents: [folderId] }),
    },
    { hosts: ["www.googleapis.com"], path: /^\/upload\/drive\/v3\/files$/, allowQuery: true },
  );
  if (response.status === 403 || response.status === 404) {
    throw new HttpError(409, "setup_needed", {
      integration: "drive_upload",
      detail:
        "Google refused this folder. drive.file can write to folders this app created or that you granted with Picker. Browsing existing folders needs drive.readonly, documented in the setup guide.",
    });
  }
  if (isRedirect(response.status) || (response.status !== 200 && response.status !== 201)) {
    throw new HttpError(502, "upload_failed", {
      detail: `Google did not open an upload session (HTTP ${response.status}).`,
      extra: { retryable: response.status >= 500 || response.status === 429 },
    });
  }
  const location = response.headers.get("location");
  if (!location || !isResumeLocation(location)) {
    throw new HttpError(502, "upload_failed", {
      detail: "Google did not return a usable upload session.",
      extra: { retryable: true },
    });
  }
  return location;
}

export function isResumeLocation(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "www.googleapis.com" &&
      url.pathname.startsWith("/upload/drive/v3/") &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

export async function putUploadChunk(
  fetchImpl: typeof fetch,
  sessionUri: string,
  bytes: Uint8Array,
  start: number,
  end: number,
  total: number,
): Promise<{ status: number; received: number | null; file?: { id?: string; webViewLink?: string } }> {
  if (!isResumeLocation(sessionUri)) throw new HttpError(400, "blocked_url");
  const response = await safeFetch(
    fetchImpl,
    sessionUri,
    {
      method: "PUT",
      headers: {
        "content-length": String(bytes.byteLength),
        "content-range": `bytes ${start}-${end}/${total}`,
      },
      body: bytes,
    },
    { hosts: ["www.googleapis.com"], path: /^\/upload\/drive\/v3\//, allowQuery: true },
  );
  if (isRedirect(response.status)) {
    throw new HttpError(502, "upload_failed", { detail: "Upload redirect was not followed.", extra: { retryable: false } });
  }
  if (response.status === 308) {
    const range = response.headers.get("range");
    const match = range?.match(/bytes=\d+-(\d+)/);
    const received = match ? Number(match[1]) + 1 : end + 1;
    return { status: 308, received };
  }
  if (response.status === 200 || response.status === 201) {
    let file: { id?: string; webViewLink?: string } | undefined;
    try {
      file = (await response.json()) as { id?: string; webViewLink?: string };
    } catch {
      file = undefined;
    }
    return { status: response.status, received: total, file };
  }
  throw new HttpError(502, "upload_failed", {
    detail: `Google Drive upload failed (HTTP ${response.status}).`,
    extra: { retryable: response.status >= 500 || response.status === 408 || response.status === 429 },
  });
}

export async function probeUpload(
  fetchImpl: typeof fetch,
  sessionUri: string,
  total: number,
): Promise<{ status: number; received: number }> {
  if (!isResumeLocation(sessionUri)) throw new HttpError(400, "blocked_url");
  const response = await safeFetch(
    fetchImpl,
    sessionUri,
    {
      method: "PUT",
      headers: {
        "content-length": "0",
        "content-range": `bytes */${total}`,
      },
    },
    { hosts: ["www.googleapis.com"], path: /^\/upload\/drive\/v3\//, allowQuery: true },
  );
  if (response.status === 308) {
    const range = response.headers.get("range");
    const match = range?.match(/bytes=\d+-(\d+)/);
    return { status: 308, received: match ? Number(match[1]) + 1 : 0 };
  }
  if (response.status === 200 || response.status === 201) return { status: response.status, received: total };
  if (response.status === 404) {
    throw new HttpError(409, "upload_restart", { detail: "The upload session expired.", extra: { restart: true } });
  }
  throw new HttpError(502, "upload_failed", {
    detail: `Google Drive upload probe failed (HTTP ${response.status}).`,
    extra: { retryable: true },
  });
}

export async function downloadThumbnail(
  fetchImpl: typeof fetch,
  accessToken: string,
  meta: DriveFileMeta,
  limit: number,
): Promise<{ bytes: ArrayBuffer; contentType: string }> {
  if (meta.thumbnailLink) {
    let thumb: URL;
    try {
      thumb = new URL(meta.thumbnailLink);
    } catch {
      thumb = new URL("https://invalid.invalid/");
    }
    const hostOk =
      thumb.protocol === "https:" &&
      (thumb.hostname === "googleusercontent.com" || thumb.hostname.endsWith(".googleusercontent.com"));
    if (hostOk) {
      const response = await fetchImpl(thumb.toString(), {
        headers: { authorization: `Bearer ${accessToken}` },
        redirect: "manual",
      });
      if (response.status === 200) {
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength <= limit) {
          return { bytes, contentType: response.headers.get("content-type")?.split(";")[0] || "image/jpeg" };
        }
      }
    }
  }
  if (meta.size != null && meta.size > limit) throw new HttpError(413, "too_large");
  const response = await googleGet(
    fetchImpl,
    `https://www.googleapis.com/drive/v3/files/${meta.id}?alt=media&supportsAllDrives=true`,
    accessToken,
    /^\/drive\/v3\/files\/[a-zA-Z0-9_-]+$/,
  );
  if (response.status !== 200) throw new HttpError(502, "drive_media");
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > limit) throw new HttpError(413, "too_large");
  return { bytes, contentType: meta.mimeType };
}

async function googleGet(
  fetchImpl: typeof fetch,
  target: string,
  accessToken: string,
  path: RegExp,
): Promise<Response> {
  return safeFetch(
    fetchImpl,
    target,
    { headers: { authorization: `Bearer ${accessToken}` } },
    { hosts: ["www.googleapis.com"], path, allowQuery: true },
  );
}

export interface SheetRow {
  job_id: string;
  agent: string;
  task: string;
  status: string;
  output_url: string;
  note: string;
  updated_at: string;
}

export function sheetForAgent(env: Env, agent: AgentSlug): { spreadsheetId: string } | null {
  if (agent === "slack") {
    if (!env.SLACK_LOG_SHEET_ID || !isDriveId(env.SLACK_LOG_SHEET_ID)) return null;
    return { spreadsheetId: env.SLACK_LOG_SHEET_ID };
  }
  return { spreadsheetId: TRACKER_SHEET_ID };
}

export async function readJobSheet(
  fetchImpl: typeof fetch,
  accessToken: string,
  spreadsheetId: string,
): Promise<{ rows: SheetRow[] } | { error: string }> {
  if (!isDriveId(spreadsheetId)) return { error: "The sheet id is not valid." };
  const range = encodeURIComponent(`${SHEET_TAB}!A1:G500`);
  const response = await safeFetch(
    fetchImpl,
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}`,
    { headers: { authorization: `Bearer ${accessToken}` } },
    {
      hosts: ["sheets.googleapis.com"],
      path: /^\/v4\/spreadsheets\/[a-zA-Z0-9_-]+\/values\/.+/,
      allowQuery: true,
    },
  );
  if (response.status === 403 || response.status === 404) {
    return { error: "Google refused the sheet read. The grant needs spreadsheets.readonly, and the Automate Jobs tab has to exist." };
  }
  if (response.status !== 200) return { error: `Google sheet read failed (HTTP ${response.status}).` };
  const body = (await response.json()) as { values?: string[][] };
  const values = body.values ?? [];
  if (values.length === 0) return { error: "The Automate Jobs tab is empty." };
  const header = values[0]?.map((cell) => cell.trim().toLowerCase()) ?? [];
  const expected = [...SHEET_COLUMNS];
  if (expected.some((column, index) => header[index] !== column)) {
    return { error: "The sheet header does not match the status convention." };
  }
  const rows: SheetRow[] = [];
  for (const raw of values.slice(1)) {
    if (!raw[0]) continue;
    rows.push({
      job_id: raw[0].trim(),
      agent: raw[1]?.trim() ?? "",
      task: raw[2]?.trim() ?? "",
      status: raw[3]?.trim().toLowerCase() ?? "",
      output_url: raw[4]?.trim() ?? "",
      note: raw[5]?.trim() ?? "",
      updated_at: raw[6]?.trim() ?? "",
    });
  }
  return { rows };
}
