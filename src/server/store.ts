import type { JobStatus } from "../shared/catalog";

export interface Sql {
  exec(query: string): Promise<void>;
  all<T>(query: string, ...params: unknown[]): Promise<T[]>;
  first<T>(query: string, ...params: unknown[]): Promise<T | null>;
  run(query: string, ...params: unknown[]): Promise<{ changes: number }>;
}

export function d1sql(db: D1Database): Sql {
  return {
    async exec(query) {
      await db.exec(query);
    },
    async all<T>(query: string, ...params: unknown[]) {
      const statement = params.length ? db.prepare(query).bind(...params) : db.prepare(query);
      const result = await statement.all<T>();
      return result.results ?? [];
    },
    async first<T>(query: string, ...params: unknown[]) {
      const statement = params.length ? db.prepare(query).bind(...params) : db.prepare(query);
      const row = await statement.first<T>();
      return row ?? null;
    },
    async run(query, ...params) {
      const statement = params.length ? db.prepare(query).bind(...params) : db.prepare(query);
      const result = await statement.run();
      return { changes: result.meta?.changes ?? 0 };
    },
  };
}

export interface JobRow {
  id: string;
  idempotency_key: string;
  agent_slug: string;
  task: string;
  status: string;
  send_state: string;
  stale: number;
  created_at: string;
  updated_at: string;
  accepted_at: string | null;
  run_uuid: string | null;
  output_url: string | null;
  note: string | null;
  error: string | null;
  callback_token_hash: string;
  callback_failures: number;
}

export interface CredentialRow {
  email: string | null;
  refresh_token_enc: string;
  access_token_enc: string | null;
  access_expires_at: string | null;
  scopes: string;
  updated_at: string;
}

export interface UploadRow {
  id: string;
  folder_id: string;
  folder_key: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  received_bytes: number;
  session_uri_enc: string | null;
  status: string;
  error: string | null;
  drive_file_id: string | null;
  web_view_link: string | null;
  created_at: string;
  updated_at: string;
}

export async function insertJob(
  sql: Sql,
  row: {
    id: string;
    idempotencyKey: string;
    agent: string;
    task: string;
    status: JobStatus;
    createdAt: string;
    callbackTokenHash: string;
  },
): Promise<void> {
  await sql.run(
    `INSERT INTO jobs (
      id, idempotency_key, agent_slug, task, status, send_state, stale,
      created_at, updated_at, callback_token_hash, callback_failures
    ) VALUES (?, ?, ?, ?, ?, 'idle', 0, ?, ?, ?, 0)`,
    row.id,
    row.idempotencyKey,
    row.agent,
    row.task,
    row.status,
    row.createdAt,
    row.createdAt,
    row.callbackTokenHash,
  );
}

export async function findJobByIdempotency(
  sql: Sql,
  agent: string,
  task: string,
  idempotencyKey: string,
): Promise<JobRow | null> {
  return sql.first<JobRow>(
    "SELECT * FROM jobs WHERE agent_slug = ? AND task = ? AND idempotency_key = ?",
    agent,
    task,
    idempotencyKey,
  );
}

export async function getJob(sql: Sql, id: string): Promise<JobRow | null> {
  return sql.first<JobRow>("SELECT * FROM jobs WHERE id = ?", id);
}

export async function listJobs(sql: Sql, agent: string | null): Promise<JobRow[]> {
  if (agent) {
    return sql.all<JobRow>(
      "SELECT * FROM jobs WHERE agent_slug = ? ORDER BY created_at DESC LIMIT 100",
      agent,
    );
  }
  return sql.all<JobRow>("SELECT * FROM jobs ORDER BY created_at DESC LIMIT 100");
}

export async function claimSend(sql: Sql, id: string, now: string): Promise<boolean> {
  const result = await sql.run(
    "UPDATE jobs SET send_state = 'sending', updated_at = ? WHERE id = ? AND send_state = 'idle'",
    now,
    id,
  );
  return result.changes === 1;
}

export async function markAccepted(
  sql: Sql,
  id: string,
  now: string,
  runUuid: string | null,
): Promise<void> {
  await sql.run(
    `UPDATE jobs
     SET send_state = 'sent', status = 'requested', accepted_at = ?, run_uuid = ?, error = NULL, updated_at = ?, stale = 0
     WHERE id = ?`,
    now,
    runUuid,
    now,
    id,
  );
}

export async function markSendFailed(sql: Sql, id: string, now: string, error: string): Promise<void> {
  await sql.run(
    `UPDATE jobs
     SET send_state = 'error', status = 'failed', error = ?, updated_at = ?, stale = 0
     WHERE id = ?`,
    error,
    now,
    id,
  );
}

export async function saveOutcome(
  sql: Sql,
  id: string,
  outcome: { status: JobStatus; outputUrl: string | null; note: string | null; error: string | null; stale: boolean; now: string },
): Promise<void> {
  await sql.run(
    `UPDATE jobs
     SET status = ?, output_url = ?, note = ?, error = ?, stale = ?, updated_at = ?, callback_failures = 0
     WHERE id = ?`,
    outcome.status,
    outcome.outputUrl,
    outcome.note,
    outcome.error,
    outcome.stale ? 1 : 0,
    outcome.now,
    id,
  );
}

export async function markStaleFlag(sql: Sql, id: string, stale: boolean): Promise<void> {
  await sql.run("UPDATE jobs SET stale = ? WHERE id = ?", stale ? 1 : 0, id);
}

export async function bumpCallbackFailure(sql: Sql, id: string): Promise<void> {
  await sql.run("UPDATE jobs SET callback_failures = callback_failures + 1 WHERE id = ?", id);
}

export async function getCredential(sql: Sql): Promise<CredentialRow | null> {
  return sql.first<CredentialRow>("SELECT * FROM oauth_credentials WHERE id = 1");
}

export async function saveCredential(
  sql: Sql,
  row: {
    email: string | null;
    refreshTokenEnc: string;
    accessTokenEnc: string | null;
    accessExpiresAt: string | null;
    scopes: string;
    updatedAt: string;
  },
): Promise<void> {
  await sql.run("DELETE FROM oauth_credentials WHERE id = 1");
  await sql.run(
    `INSERT INTO oauth_credentials (
      id, email, refresh_token_enc, access_token_enc, access_expires_at, scopes, updated_at
    ) VALUES (1, ?, ?, ?, ?, ?, ?)`,
    row.email,
    row.refreshTokenEnc,
    row.accessTokenEnc,
    row.accessExpiresAt,
    row.scopes,
    row.updatedAt,
  );
}

export async function updateAccessToken(
  sql: Sql,
  accessTokenEnc: string,
  accessExpiresAt: string,
  scopes: string,
  updatedAt: string,
): Promise<void> {
  await sql.run(
    `UPDATE oauth_credentials
     SET access_token_enc = ?, access_expires_at = ?, scopes = ?, updated_at = ?
     WHERE id = 1`,
    accessTokenEnc,
    accessExpiresAt,
    scopes,
    updatedAt,
  );
}

export async function deleteCredential(sql: Sql): Promise<void> {
  await sql.run("DELETE FROM oauth_credentials WHERE id = 1");
}

export async function saveOauthState(sql: Sql, state: string, verifierEnc: string, createdAt: string): Promise<void> {
  await sql.run(
    "INSERT INTO oauth_states (state, code_verifier_enc, created_at) VALUES (?, ?, ?)",
    state,
    verifierEnc,
    createdAt,
  );
}

export async function takeOauthState(
  sql: Sql,
  state: string,
): Promise<{ code_verifier_enc: string; created_at: string } | null> {
  const row = await sql.first<{ code_verifier_enc: string; created_at: string }>(
    "SELECT code_verifier_enc, created_at FROM oauth_states WHERE state = ?",
    state,
  );
  if (!row) return null;
  await sql.run("DELETE FROM oauth_states WHERE state = ?", state);
  return row;
}

export async function deleteExpiredStates(sql: Sql, cutoffIso: string): Promise<void> {
  await sql.run("DELETE FROM oauth_states WHERE created_at < ?", cutoffIso);
}

export async function insertUpload(
  sql: Sql,
  row: {
    id: string;
    folderId: string;
    folderKey: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    now: string;
  },
): Promise<void> {
  await sql.run(
    `INSERT INTO upload_sessions (
      id, folder_id, folder_key, file_name, mime_type, size_bytes, received_bytes,
      status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 0, 'starting', ?, ?)`,
    row.id,
    row.folderId,
    row.folderKey,
    row.fileName,
    row.mimeType,
    row.sizeBytes,
    row.now,
    row.now,
  );
}

export async function getUpload(sql: Sql, id: string): Promise<UploadRow | null> {
  return sql.first<UploadRow>("SELECT * FROM upload_sessions WHERE id = ?", id);
}

export async function updateUpload(
  sql: Sql,
  id: string,
  patch: {
    received?: number;
    sessionUriEnc?: string | null;
    status?: string;
    error?: string | null;
    driveFileId?: string | null;
    webViewLink?: string | null;
    now: string;
  },
): Promise<void> {
  const current = await getUpload(sql, id);
  if (!current) return;
  await sql.run(
    `UPDATE upload_sessions
     SET received_bytes = ?, session_uri_enc = ?, status = ?, error = ?, drive_file_id = ?, web_view_link = ?, updated_at = ?
     WHERE id = ?`,
    patch.received ?? current.received_bytes,
    patch.sessionUriEnc === undefined ? current.session_uri_enc : patch.sessionUriEnc,
    patch.status ?? current.status,
    patch.error === undefined ? current.error : patch.error,
    patch.driveFileId === undefined ? current.drive_file_id : patch.driveFileId,
    patch.webViewLink === undefined ? current.web_view_link : patch.webViewLink,
    patch.now,
    id,
  );
}

export async function loginFailure(sql: Sql, nowMs: number): Promise<{ locked: boolean; lockedUntil: string | null }> {
  const row = await sql.first<{ failures: number; locked_until: string | null }>(
    "SELECT failures, locked_until FROM login_attempts WHERE id = 1",
  );
  if (row?.locked_until && Date.parse(row.locked_until) > nowMs) {
    return { locked: true, lockedUntil: row.locked_until };
  }
  const failures = (row?.failures ?? 0) + 1;
  if (failures >= 5) {
    const lockedUntil = new Date(nowMs + 15 * 60 * 1000).toISOString();
    await sql.run("DELETE FROM login_attempts WHERE id = 1");
    await sql.run(
      "INSERT INTO login_attempts (id, failures, locked_until) VALUES (1, 0, ?)",
      lockedUntil,
    );
    return { locked: true, lockedUntil };
  }
  await sql.run("DELETE FROM login_attempts WHERE id = 1");
  await sql.run("INSERT INTO login_attempts (id, failures, locked_until) VALUES (1, ?, NULL)", failures);
  return { locked: false, lockedUntil: null };
}

export async function loginLocked(sql: Sql, nowMs: number): Promise<boolean> {
  const row = await sql.first<{ locked_until: string | null }>(
    "SELECT locked_until FROM login_attempts WHERE id = 1",
  );
  return Boolean(row?.locked_until && Date.parse(row.locked_until) > nowMs);
}

export async function clearLoginFailures(sql: Sql): Promise<void> {
  await sql.run("DELETE FROM login_attempts WHERE id = 1");
}
