import {
  DEFAULT_STALE_REQUESTED_MS,
  DEFAULT_STALE_RUNNING_MS,
  isPostingTask,
  type JobStatus,
} from "./catalog";
import { isPublishedPostUrl, isSafeHttpsUrl } from "./urls";

export interface StaleInput {
  status: string;
  updated_at: string;
}

export interface StaleThresholds {
  requested: number;
  running: number;
}

export function defaultThresholds(): StaleThresholds {
  return { requested: DEFAULT_STALE_REQUESTED_MS, running: DEFAULT_STALE_RUNNING_MS };
}

export function evaluateStale(
  job: StaleInput,
  nowMs: number,
  thresholds: StaleThresholds,
): { status: JobStatus; stale: boolean } {
  const status = job.status as JobStatus;
  const updated = Date.parse(job.updated_at);
  const age = Number.isFinite(updated) ? nowMs - updated : thresholds.running + 1;
  if (status === "requested" && age >= thresholds.requested) {
    return { status: "unknown", stale: true };
  }
  if (status === "running" && age >= thresholds.running) {
    return { status: "running", stale: true };
  }
  return { status: isJobStatus(status) ? status : "unknown", stale: false };
}

export function isJobStatus(value: string): value is JobStatus {
  return (
    value === "requested" ||
    value === "running" ||
    value === "needs input" ||
    value === "completed" ||
    value === "failed" ||
    value === "unknown"
  );
}

const OPEN_FOR_AGENT = new Set(["requested", "running", "needs input", "unknown"]);

export interface StatusWrite {
  status: string;
  outputUrl?: string | null;
  note?: string | null;
}

export interface AppliedStatus {
  ignored: boolean;
  status: JobStatus;
  outputUrl: string | null;
  note: string | null;
  reason?: string;
}

export function applyReportedStatus(job: { status: string; task: string }, write: StatusWrite): AppliedStatus {
  const current = isJobStatus(job.status) ? job.status : "unknown";
  if (!OPEN_FOR_AGENT.has(current)) {
    return { ignored: true, status: current, outputUrl: null, note: null, reason: "terminal" };
  }
  if (
    write.status !== "running" &&
    write.status !== "needs input" &&
    write.status !== "completed" &&
    write.status !== "failed"
  ) {
    return { ignored: true, status: current, outputUrl: null, note: null, reason: "bad_status" };
  }
  const outputUrl = cleanOptionalUrl(write.outputUrl);
  const note = cleanNote(write.note);
  if (write.outputUrl && !outputUrl) {
    return { ignored: true, status: current, outputUrl: null, note: null, reason: "bad_output_url" };
  }
  if (isPostingTask(job.task) && write.status === "completed" && !isPublishedPostUrl(outputUrl)) {
    return {
      ignored: false,
      status: "unknown",
      outputUrl: null,
      note: "A posting job was reported completed without a published TikTok URL, so it is unknown until you reconcile it.",
    };
  }
  return { ignored: false, status: write.status, outputUrl, note };
}

export function applyOwnerStatus(job: { task: string }, write: StatusWrite): AppliedStatus {
  if (!isJobStatus(write.status) || write.status === "requested") {
    return { ignored: true, status: "unknown", outputUrl: null, note: null, reason: "bad_status" };
  }
  const outputUrl = cleanOptionalUrl(write.outputUrl);
  if (write.outputUrl && !outputUrl) {
    return { ignored: true, status: "unknown", outputUrl: null, note: null, reason: "bad_output_url" };
  }
  if (isPostingTask(job.task) && write.status === "completed" && !isPublishedPostUrl(outputUrl)) {
    return {
      ignored: false,
      status: "unknown",
      outputUrl: null,
      note: "Completed was not saved. A posting job needs a published TikTok URL.",
    };
  }
  return {
    ignored: false,
    status: write.status,
    outputUrl,
    note: cleanNote(write.note),
  };
}

function cleanOptionalUrl(value: string | null | undefined): string | null {
  if (value == null || value === "") return null;
  const trimmed = value.trim();
  if (!isSafeHttpsUrl(trimmed)) return null;
  return trimmed;
}

function cleanNote(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.replace(/[\u0000-\u001f]/g, " ").trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 2000);
}

export const STALE_REQUEST_NOTE =
  "No start was recorded before this request went stale. Status is unknown until the sheet, the agent callback, or a manual reconcile updates it.";
