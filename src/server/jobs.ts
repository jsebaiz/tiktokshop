import {
  agentBySlug,
  AGENT_SLUGS,
  DEFAULT_STALE_REQUESTED_MS,
  DEFAULT_STALE_RUNNING_MS,
  isPostingTask,
  SHEET_COLUMNS,
  SHEET_TAB,
  taskByKey,
  type AgentSlug,
  type JobStatus,
} from "../shared/catalog";
import {
  applyOwnerStatus,
  applyReportedStatus,
  evaluateStale,
  STALE_REQUEST_NOTE,
  type StaleThresholds,
} from "../shared/status";
import { isAllowedWebhookUrl } from "../shared/urls";
import { API_BASE } from "../shared/paths";
import { randomToken, safeEqual, sanitizeMessage, sha256Hex } from "./crypto";
import type { Env } from "./env";
import { readJobSheet, requireAccessToken, scopeFlags, sheetForAgent } from "./google";
import { HttpError, isRedirect, safeFetch } from "./http";
import { AGENT_IDS } from "./privateConfig";
import {
  bumpCallbackFailure,
  claimSend,
  findJobByIdempotency,
  getJob,
  insertJob,
  listJobs,
  markAccepted,
  markSendFailed,
  markStaleFlag,
  saveOutcome,
  type JobRow,
  type Sql,
} from "./store";

export interface JobView {
  id: string;
  agent: string;
  task: string;
  taskLabel: string;
  posting: boolean;
  status: JobStatus;
  stale: boolean;
  delivery: "unsent" | "sending" | "accepted" | "rejected";
  createdAt: string;
  updatedAt: string;
  acceptedAt: string | null;
  outputUrl: string | null;
  note: string | null;
  error: string | null;
  runUuid: string | null;
}

export interface WebhookTarget {
  url: string;
  key: string;
}

export function webhookFor(
  env: Env,
  agent: AgentSlug,
): { state: "ready"; target: WebhookTarget } | { state: "setup_needed" } | { state: "rejected_host" } {
  const pair = readWebhook(env, agent);
  if (!pair.url || !pair.key) return { state: "setup_needed" };
  if (!isAllowedWebhookUrl(pair.url)) return { state: "rejected_host" };
  return { state: "ready", target: { url: pair.url, key: pair.key } };
}

function readWebhook(env: Env, agent: AgentSlug): { url?: string; key?: string } {
  switch (agent) {
    case "fling":
      return { url: env.WEBHOOK_URL_FLING, key: env.WEBHOOK_KEY_FLING };
    case "cling":
      return { url: env.WEBHOOK_URL_CLING, key: env.WEBHOOK_KEY_CLING };
    case "sling":
      return { url: env.WEBHOOK_URL_SLING, key: env.WEBHOOK_KEY_SLING };
    case "bling":
      return { url: env.WEBHOOK_URL_BLING, key: env.WEBHOOK_KEY_BLING };
    case "pling":
      return { url: env.WEBHOOK_URL_PLING, key: env.WEBHOOK_KEY_PLING };
    case "slack":
      return { url: env.WEBHOOK_URL_SLACK, key: env.WEBHOOK_KEY_SLACK };
  }
}

export function thresholdsFor(env: Env): StaleThresholds {
  return {
    requested: positiveMs(env.JOB_STALE_REQUESTED_MS, DEFAULT_STALE_REQUESTED_MS),
    running: positiveMs(env.JOB_STALE_RUNNING_MS, DEFAULT_STALE_RUNNING_MS),
  };
}

function positiveMs(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 60_000) return fallback;
  return parsed;
}

export function webhookMap(env: Env): Record<AgentSlug, "ready" | "setup_needed" | "rejected_host"> {
  const map = {} as Record<AgentSlug, "ready" | "setup_needed" | "rejected_host">;
  for (const slug of AGENT_SLUGS) map[slug] = webhookFor(env, slug).state;
  return map;
}

export async function startJob(options: {
  sql: Sql;
  env: Env;
  fetchImpl: typeof fetch;
  agent: string;
  task: string;
  idempotencyKey: string;
  nowMs: number;
}): Promise<{ job: JobView; created: boolean }> {
  const agent = agentBySlug(options.agent);
  if (!agent) throw new HttpError(400, "unknown_agent");
  const task = taskByKey(agent, options.task);
  if (!task) throw new HttpError(400, "unknown_task");
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(options.idempotencyKey)) {
    throw new HttpError(400, "bad_idempotency_key");
  }
  const webhook = webhookFor(options.env, agent.slug);
  if (webhook.state === "setup_needed") {
    throw new HttpError(409, "setup_needed", {
      integration: "webhook",
      detail: "This agent has no webhook URL and key yet. Live start stays off.",
    });
  }
  if (webhook.state === "rejected_host") {
    throw new HttpError(409, "setup_needed", {
      integration: "webhook_host",
      detail: "The webhook URL is not on the allowlist. Only https://api2.cursor.sh/automations/webhook/… is accepted.",
    });
  }
  const existing = await findJobByIdempotency(options.sql, agent.slug, task.key, options.idempotencyKey);
  if (existing) {
    if (existing.send_state === "idle") {
      return sendClaimed(options, existing, webhook.target, false);
    }
    return { job: await syncJob(options.sql, existing, options.nowMs, thresholdsFor(options.env)), created: false };
  }
  const id = crypto.randomUUID();
  const callbackToken = randomToken(32);
  const now = new Date(options.nowMs).toISOString();
  try {
    await insertJob(options.sql, {
      id,
      idempotencyKey: options.idempotencyKey,
      agent: agent.slug,
      task: task.key,
      status: "requested",
      createdAt: now,
      callbackTokenHash: await sha256Hex(callbackToken),
    });
  } catch {
    const raced = await findJobByIdempotency(options.sql, agent.slug, task.key, options.idempotencyKey);
    if (!raced) throw new HttpError(500, "internal");
    return { job: await syncJob(options.sql, raced, options.nowMs, thresholdsFor(options.env)), created: false };
  }
  const row = await getJob(options.sql, id);
  if (!row) throw new HttpError(500, "internal");
  return sendClaimed(options, row, webhook.target, true, callbackToken);
}

async function sendClaimed(
  options: {
    sql: Sql;
    env: Env;
    fetchImpl: typeof fetch;
    nowMs: number;
  },
  row: JobRow,
  webhook: WebhookTarget,
  created: boolean,
  callbackToken?: string,
): Promise<{ job: JobView; created: boolean }> {
  const now = new Date(options.nowMs).toISOString();
  const claimed = await claimSend(options.sql, row.id, now);
  if (!claimed) {
    const current = await getJob(options.sql, row.id);
    if (!current) throw new HttpError(500, "internal");
    return { job: await syncJob(options.sql, current, options.nowMs, thresholdsFor(options.env)), created: false };
  }
  const token = callbackToken ?? null;
  const body = webhookBody(options.env, row, token);
  let response: Response;
  try {
    response = await safeFetch(
      options.fetchImpl,
      webhook.url,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${webhook.key}`,
          "x-automation-key": webhook.key,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      },
      { hosts: ["api2.cursor.sh"], path: /^\/automations\/webhook\/[A-Za-z0-9_-]+$/ },
    );
  } catch {
    await markSendFailed(
      options.sql,
      row.id,
      new Date(options.nowMs).toISOString(),
      "Webhook request timed out or failed before a response. It was not retried, because a late 200 could still have started a run.",
    );
    const failed = await getJob(options.sql, row.id);
    if (!failed) throw new HttpError(500, "internal");
    return { job: toView(failed), created };
  }
  if (isRedirect(response.status)) {
    await markSendFailed(options.sql, row.id, now, "Webhook redirect was not followed. The run was not accepted.");
  } else if (response.status !== 200) {
    await markSendFailed(
      options.sql,
      row.id,
      now,
      `Webhook was not accepted (HTTP ${response.status}). A run did not start.`,
    );
  } else {
    let runUuid: string | null = null;
    try {
      const parsed = (await response.json()) as { runUuid?: unknown };
      if (typeof parsed.runUuid === "string" && /^[A-Za-z0-9_-]{8,80}$/.test(parsed.runUuid)) {
        runUuid = parsed.runUuid;
      }
    } catch {
      runUuid = null;
    }
    await markAccepted(options.sql, row.id, now, runUuid);
  }
  const saved = await getJob(options.sql, row.id);
  if (!saved) throw new HttpError(500, "internal");
  return { job: toView(saved), created };
}

function webhookBody(env: Env, row: JobRow, callbackToken: string | null): Record<string, unknown> {
  const agent = row.agent_slug as AgentSlug;
  const payload: Record<string, unknown> = {
    v: 1,
    jobId: row.id,
    agent,
    agentId: AGENT_IDS[agent],
    task: row.task,
    requestedAt: row.created_at,
  };
  const sheet = sheetForAgent(env, agent);
  if (sheet) {
    payload.sheet = { spreadsheetId: sheet.spreadsheetId, tab: SHEET_TAB, columns: SHEET_COLUMNS };
  }
  const reportUrl = callbackUrl(env, row.id);
  if (reportUrl && callbackToken) {
    payload.report = { url: reportUrl, authorization: `Bearer ${callbackToken}` };
  }
  return payload;
}

function callbackUrl(env: Env, jobId: string): string | null {
  const base = env.PUBLIC_BASE_URL?.trim();
  if (!base) return null;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  return `${url.origin}${API_BASE}/jobs/${jobId}/report`;
}

export async function jobsForApi(sql: Sql, agent: string | null, nowMs: number, thresholds: StaleThresholds): Promise<JobView[]> {
  if (agent && !agentBySlug(agent)) throw new HttpError(400, "unknown_agent");
  const rows = await listJobs(sql, agent);
  const views: JobView[] = [];
  for (const row of rows) views.push(await syncJob(sql, row, nowMs, thresholds));
  return views;
}

export async function jobForApi(sql: Sql, id: string, nowMs: number, thresholds: StaleThresholds): Promise<JobView> {
  const row = await getJob(sql, id);
  if (!row) throw new HttpError(404, "not_found");
  return syncJob(sql, row, nowMs, thresholds);
}

async function syncJob(sql: Sql, row: JobRow, nowMs: number, thresholds: StaleThresholds): Promise<JobView> {
  const next = evaluateStale(row, nowMs, thresholds);
  if (next.status !== row.status) {
    await saveOutcome(sql, row.id, {
      status: next.status,
      outputUrl: row.output_url,
      note: row.note ?? STALE_REQUEST_NOTE,
      error: row.error,
      stale: true,
      now: new Date(nowMs).toISOString(),
    });
    const updated = await getJob(sql, row.id);
    return toView(updated ?? row);
  }
  if (next.stale !== Boolean(row.stale)) {
    await markStaleFlag(sql, row.id, next.stale);
    row = { ...row, stale: next.stale ? 1 : 0 };
  }
  return toView({ ...row, status: next.status, stale: next.stale ? 1 : 0 });
}

export function toView(row: JobRow): JobView {
  const agent = agentBySlug(row.agent_slug);
  const task = agent ? taskByKey(agent, row.task) : undefined;
  const delivery =
    row.send_state === "sent"
      ? "accepted"
      : row.send_state === "sending"
        ? "sending"
        : row.send_state === "error"
          ? "rejected"
          : "unsent";
  return {
    id: row.id,
    agent: row.agent_slug,
    task: row.task,
    taskLabel: task?.label ?? row.task,
    posting: isPostingTask(row.task),
    status: (row.status as JobStatus) ?? "unknown",
    stale: Boolean(row.stale),
    delivery,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    acceptedAt: row.accepted_at,
    outputUrl: row.output_url,
    note: row.note,
    error: row.error,
    runUuid: row.run_uuid,
  };
}

export async function reportFromAgent(options: {
  sql: Sql;
  id: string;
  token: string;
  body: unknown;
  nowMs: number;
}): Promise<JobView> {
  const row = await getJob(options.sql, options.id);
  if (!row) throw new HttpError(404, "not_found");
  if (row.callback_failures >= 8) throw new HttpError(429, "callback_locked");
  const hash = await sha256Hex(options.token);
  if (!safeEqual(hash, row.callback_token_hash)) {
    await bumpCallbackFailure(options.sql, row.id);
    throw new HttpError(401, "unauthorized");
  }
  const write = readStatusBody(options.body);
  const applied = applyReportedStatus(row, write);
  if (applied.reason === "bad_status" || applied.reason === "bad_output_url") {
    throw new HttpError(400, applied.reason);
  }
  if (!applied.ignored) {
    await saveOutcome(options.sql, row.id, {
      status: applied.status,
      outputUrl: applied.outputUrl,
      note: applied.note ?? row.note,
      error: applied.status === "failed" ? applied.note : null,
      stale: false,
      now: new Date(options.nowMs).toISOString(),
    });
  }
  const saved = await getJob(options.sql, row.id);
  if (!saved) throw new HttpError(500, "internal");
  return toView(saved);
}

export async function ownerReconcile(options: {
  sql: Sql;
  env: Env;
  fetchImpl: typeof fetch;
  id: string;
  body: unknown;
  nowMs: number;
}): Promise<{ job: JobView; sheet: "ok" | "setup_needed" | "error" | "unchanged"; detail?: string }> {
  const row = await getJob(options.sql, options.id);
  if (!row) throw new HttpError(404, "not_found");
  const record = asRecord(options.body);
  if (record?.action === "set") {
    const applied = applyOwnerStatus(row, {
      status: String(record.status ?? ""),
      outputUrl: typeof record.outputUrl === "string" ? record.outputUrl : null,
      note: typeof record.note === "string" ? record.note : null,
    });
    if (applied.ignored) throw new HttpError(400, applied.reason ?? "bad_status");
    await saveOutcome(options.sql, row.id, {
      status: applied.status,
      outputUrl: applied.outputUrl,
      note: applied.note,
      error: applied.status === "failed" ? applied.note : null,
      stale: false,
      now: new Date(options.nowMs).toISOString(),
    });
    const saved = await getJob(options.sql, row.id);
    if (!saved) throw new HttpError(500, "internal");
    return { job: toView(saved), sheet: "unchanged" };
  }
  const sheetResult = await pullSheet(options.sql, options.env, options.fetchImpl, row, options.nowMs);
  const current = await getJob(options.sql, row.id);
  if (!current) throw new HttpError(500, "internal");
  const job = await syncJob(options.sql, current, options.nowMs, thresholdsFor(options.env));
  return { job, sheet: sheetResult.sheet, detail: sheetResult.detail };
}

async function pullSheet(
  sql: Sql,
  env: Env,
  fetchImpl: typeof fetch,
  row: JobRow,
  nowMs: number,
): Promise<{ sheet: "ok" | "setup_needed" | "error" | "unchanged"; detail?: string }> {
  const agent = row.agent_slug as AgentSlug;
  const target = sheetForAgent(env, agent);
  if (!target) {
    return { sheet: "setup_needed", detail: "The Slack log sheet id is not configured." };
  }
  let token: Awaited<ReturnType<typeof requireAccessToken>>;
  try {
    token = await requireAccessToken(sql, env, fetchImpl, nowMs);
  } catch (error) {
    if (error instanceof HttpError && error.code === "setup_needed") {
      return { sheet: "setup_needed", detail: error.detail ?? "Google is not connected." };
    }
    throw error;
  }
  const flags = scopeFlags(token.scopes);
  if (!flags.sheetsReadonly) {
    return {
      sheet: "setup_needed",
      detail: "The Google grant cannot read spreadsheets. Add spreadsheets.readonly and reconnect.",
    };
  }
  const sheet = await readJobSheet(fetchImpl, token.accessToken, target.spreadsheetId);
  if ("error" in sheet) return { sheet: "error", detail: sanitizeMessage(sheet.error, 300) };
  const matches = sheet.rows.filter((item) => item.job_id === row.id);
  const found = matches.at(-1);
  if (!found) return { sheet: "unchanged", detail: "No row for this job yet." };
  if (!shouldApplySheet(row, found.updated_at)) return { sheet: "unchanged" };
  const applied = applyReportedStatus(
    { status: row.status === "unknown" ? "unknown" : row.status, task: row.task },
    { status: found.status, outputUrl: found.output_url || null, note: found.note || null },
  );
  if (applied.reason === "bad_status" || applied.reason === "bad_output_url" || applied.ignored) {
    return { sheet: "unchanged", detail: "The sheet row was not a usable status." };
  }
  await saveOutcome(sql, row.id, {
    status: applied.status,
    outputUrl: applied.outputUrl,
    note: applied.note,
    error: applied.status === "failed" ? applied.note : null,
    stale: false,
    now: found.updated_at && !Number.isNaN(Date.parse(found.updated_at)) ? new Date(found.updated_at).toISOString() : new Date(nowMs).toISOString(),
  });
  return { sheet: "ok" };
}

export async function reconcileOpenJobs(options: {
  sql: Sql;
  env: Env;
  fetchImpl: typeof fetch;
  nowMs: number;
}): Promise<{ jobs: JobView[]; sheets: Array<{ agentGroup: string; sheet: string; detail?: string }> }> {
  const sheets: Array<{ agentGroup: string; sheet: string; detail?: string }> = [];
  sheets.push({
    agentGroup: "brand",
    ...(await pullSheetForGroup(options, "brand")),
  });
  sheets.push({
    agentGroup: "slack",
    ...(await pullSheetForGroup(options, "slack")),
  });
  return {
    jobs: await jobsForApi(options.sql, null, options.nowMs, thresholdsFor(options.env)),
    sheets,
  };
}

async function pullSheetForGroup(
  options: { sql: Sql; env: Env; fetchImpl: typeof fetch; nowMs: number },
  group: "brand" | "slack",
): Promise<{ sheet: "ok" | "setup_needed" | "error" | "unchanged"; detail?: string }> {
  const sample = group === "slack" ? "slack" : "fling";
  const target = sheetForAgent(options.env, sample);
  if (!target) return { sheet: "setup_needed", detail: "The Slack log sheet id is not configured." };
  let token: Awaited<ReturnType<typeof requireAccessToken>>;
  try {
    token = await requireAccessToken(options.sql, options.env, options.fetchImpl, options.nowMs);
  } catch (error) {
    if (error instanceof HttpError && error.code === "setup_needed") {
      return { sheet: "setup_needed", detail: error.detail ?? "Google is not connected." };
    }
    throw error;
  }
  if (!scopeFlags(token.scopes).sheetsReadonly) {
    return { sheet: "setup_needed", detail: "The Google grant cannot read spreadsheets." };
  }
  const sheet = await readJobSheet(options.fetchImpl, token.accessToken, target.spreadsheetId);
  if ("error" in sheet) return { sheet: "error", detail: sanitizeMessage(sheet.error, 300) };
  const rows = await listJobs(options.sql, null);
  let applied = 0;
  for (const row of rows) {
    if (group === "slack" ? row.agent_slug !== "slack" : row.agent_slug === "slack") continue;
    const found = sheet.rows.filter((item) => item.job_id === row.id).at(-1);
    if (!found || !shouldApplySheet(row, found.updated_at)) continue;
    const next = applyReportedStatus(row, {
      status: found.status,
      outputUrl: found.output_url || null,
      note: found.note || null,
    });
    if (next.ignored || next.reason === "bad_status" || next.reason === "bad_output_url") continue;
    await saveOutcome(options.sql, row.id, {
      status: next.status,
      outputUrl: next.outputUrl,
      note: next.note,
      error: next.status === "failed" ? next.note : null,
      stale: false,
      now:
        found.updated_at && !Number.isNaN(Date.parse(found.updated_at))
          ? new Date(found.updated_at).toISOString()
          : new Date(options.nowMs).toISOString(),
    });
    applied += 1;
  }
  return applied > 0 ? { sheet: "ok" } : { sheet: "unchanged" };
}

function shouldApplySheet(row: JobRow, sheetUpdated: string): boolean {
  const sheetTime = Date.parse(sheetUpdated);
  const localTime = Date.parse(row.updated_at);
  if (Number.isFinite(sheetTime) && Number.isFinite(localTime)) return sheetTime >= localTime;
  return row.status === "requested" || row.status === "running" || row.status === "unknown";
}

function readStatusBody(body: unknown): { status: string; outputUrl: string | null; note: string | null } {
  const record = asRecord(body);
  if (!record || typeof record.status !== "string") throw new HttpError(400, "bad_status");
  return {
    status: record.status,
    outputUrl: typeof record.outputUrl === "string" ? record.outputUrl : null,
    note: typeof record.note === "string" ? record.note : null,
  };
}

function asRecord(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  return body as Record<string, unknown>;
}
