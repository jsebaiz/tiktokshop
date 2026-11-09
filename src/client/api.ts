export interface TaskInfo {
  key: string;
  label: string;
  detail: string;
  kind: "read" | "draft" | "post";
}

export interface AgentInfo {
  slug: string;
  name: string;
  stamp: string;
  role: string;
  group: "brand" | "original";
  summary: string;
  boundary: string;
  tasks: TaskInfo[];
}

export interface JobView {
  id: string;
  agent: string;
  task: string;
  taskLabel: string;
  posting: boolean;
  status: "requested" | "running" | "needs input" | "completed" | "failed" | "unknown";
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

export interface FolderInfo {
  key: string;
  label: string;
  group: "brand" | "slack";
  configured: boolean;
}

export interface Bootstrap {
  auth: "dev" | "access";
  ownerEmail: string | null;
  agents: AgentInfo[];
  setup: {
    google: "connected" | "setup_needed";
    googleEmail: string | null;
    googleOauth: boolean;
    encryption: boolean;
    scopes: { driveFile: boolean; driveReadonly: boolean; drive: boolean; sheetsReadonly: boolean };
    webhooks: Record<string, "ready" | "setup_needed" | "rejected_host">;
    slackSheet: boolean;
    slackFolders: { postr: boolean; ready: boolean; posted: boolean };
    picker: boolean;
    publicBaseUrl: boolean;
  };
  picker: { apiKey: string; appId: string } | null;
  folders: FolderInfo[];
  stale: { requestedMinutes: number; runningMinutes: number };
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

export interface ApiFailure {
  error: string;
  detail?: string;
  integration?: string;
  retryable?: boolean;
  restart?: boolean;
}

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  failure: ApiFailure | null;
}

function csrfToken(): string {
  const match = document.cookie.match(/(?:^|; )automate_csrf=([^;]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : "";
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<ApiResult<T>> {
  const headers = new Headers(init.headers);
  if (init.method && init.method !== "GET" && init.method !== "HEAD") {
    headers.set("x-automate-csrf", csrfToken());
  }
  if (init.body && !headers.has("content-type") && typeof init.body === "string") {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(path, { ...init, headers });
  if (response.status === 401) {
    window.location.href = "/automate/login";
  }
  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = null;
    }
  }
  if (!response.ok) {
    const failure = (parsed ?? { error: "request_failed" }) as ApiFailure;
    return { ok: false, status: response.status, data: null, failure };
  }
  return { ok: true, status: response.status, data: parsed as T, failure: null };
}

export function loadBootstrap(): Promise<ApiResult<Bootstrap>> {
  return api<Bootstrap>("/api/automate/bootstrap");
}

export function loadJobs(agent?: string): Promise<ApiResult<{ jobs: JobView[] }>> {
  const query = agent ? `?agent=${encodeURIComponent(agent)}` : "";
  return api<{ jobs: JobView[] }>(`/api/automate/jobs${query}`);
}

export function startJob(agent: string, task: string, idempotencyKey: string): Promise<ApiResult<{ job: JobView }>> {
  return api("/api/automate/jobs", {
    method: "POST",
    body: JSON.stringify({ agent, task, idempotencyKey }),
  });
}

export function reconcileJob(id: string, body: Record<string, unknown> = { action: "refresh" }): Promise<ApiResult<{ job: JobView; sheet: string; detail?: string }>> {
  return api(`/api/automate/jobs/${id}/reconcile`, { method: "POST", body: JSON.stringify(body) });
}

export function reconcileAll(): Promise<ApiResult<{ jobs: JobView[]; sheets: Array<{ agentGroup: string; sheet: string; detail?: string }> }>> {
  return api("/api/automate/jobs/reconcile", { method: "POST", body: "{}" });
}
