export const XP_PER_LEVEL = 3;

export interface LevelProgress {
  level: number;
  current: number;
  goal: number;
}

export function levelProgress(completed: number): LevelProgress {
  const done = Number.isFinite(completed) && completed > 0 ? Math.floor(completed) : 0;
  return {
    level: 1 + Math.floor(done / XP_PER_LEVEL),
    current: done % XP_PER_LEVEL,
    goal: XP_PER_LEVEL,
  };
}

export function completionStreak(isoTimes: readonly string[], nowMs: number): number {
  const days = new Set<string>();
  for (const iso of isoTimes) {
    const time = Date.parse(iso);
    if (Number.isNaN(time)) continue;
    days.add(new Date(time).toISOString().slice(0, 10));
  }
  if (days.size === 0) return 0;
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const yesterday = shiftDay(today, -1);
  let cursor = days.has(today) ? today : days.has(yesterday) ? yesterday : "";
  if (!cursor) return 0;
  let streak = 0;
  while (days.has(cursor)) {
    streak += 1;
    cursor = shiftDay(cursor, -1);
  }
  return streak;
}

function shiftDay(day: string, delta: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + delta * 86400000).toISOString().slice(0, 10);
}

export type Tone = "red" | "amber" | "blue" | "green";

export function jobTone(status: string, stale: boolean): Tone {
  if (status === "failed" || status === "needs input") return "red";
  if (status === "unknown" || stale) return "amber";
  if (status === "completed") return "green";
  return "blue";
}

export function attentionRank(status: string, stale: boolean): number | null {
  if (status === "failed") return 0;
  if (status === "needs input") return 1;
  if (status === "unknown" || stale) return 2;
  return null;
}

export function statusLabel(status: string, stale: boolean): string {
  if (status === "needs input") return "Needs you";
  if (status === "failed") return "Failed";
  if (stale) return "Stale";
  if (status === "unknown") return "Unknown";
  if (status === "running") return "Running";
  if (status === "requested") return "Accepted";
  if (status === "completed") return "Done";
  return "Check";
}

const SHORT_TASK: Record<string, string> = {
  "summarize-inbox": "Inbox summary",
  "draft-retainer-reply": "Retainer draft",
  "flag-deal-terms": "Deal terms",
  "draft-slideshow-script": "Slideshow script",
  "revise-overlay-text": "Overlay text",
  "list-missing-copy": "Missing copy",
  "preview-ready-post": "Post preview",
  "post-next-brand": "Brand post",
  "draft-invoice": "Invoice draft",
  "reconcile-payments": "Payment check",
  "list-overdue": "Overdue list",
  "pull-performance": "Performance pull",
  "weekly-scorecard": "Week scorecard",
  "flag-outliers": "Outlier check",
  "preview-postr": "Queue preview",
  "post-next-original": "Original post",
  "reconcile-posted": "Posted check",
};

export function shortTask(task: string, fallback: string): string {
  return SHORT_TASK[task] ?? fallback.split(/\s+/).slice(0, 3).join(" ");
}

export function jobSummary(task: string, taskLabel: string, status: string, stale: boolean): string {
  const name = shortTask(task, taskLabel);
  let line = `${name} needs a look`;
  if (status === "needs input") line = `${name} needs you`;
  else if (status === "failed") line = `${name} failed`;
  else if (stale) line = `${name} looks stale`;
  else if (status === "unknown") line = `${name} is unknown`;
  else if (status === "running") line = `${name} is running`;
  else if (status === "requested") line = `${name} was accepted`;
  else if (status === "completed") line = `${name} is done`;
  if (line.split(/\s+/).length > 8) return "This job needs a look";
  return line;
}

export function wordCount(value: string): number {
  const trimmed = value.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}
