export const AGENT_SLUGS = ["fling", "cling", "sling", "bling", "pling", "slack"] as const;

export type AgentSlug = (typeof AGENT_SLUGS)[number];

export type TaskKind = "read" | "draft" | "post";

export interface TaskDef {
  key: string;
  label: string;
  detail: string;
  kind: TaskKind;
}

export interface AgentDef {
  slug: AgentSlug;
  name: string;
  stamp: string;
  role: string;
  group: "brand" | "original";
  summary: string;
  boundary: string;
  tasks: TaskDef[];
}

export const AGENTS: readonly AgentDef[] = [
  {
    slug: "fling",
    name: "Fling",
    stamp: "Fl",
    role: "Brand email and retainer negotiation",
    group: "brand",
    summary: "Reads brand email and drafts retainer replies.",
    boundary: "Fling does not send email from this desk.",
    tasks: [
      {
        key: "summarize-inbox",
        label: "Summarize new brand email",
        detail: "Summarize the latest brand threads and name what needs a reply.",
        kind: "read",
      },
      {
        key: "draft-retainer-reply",
        label: "Draft a retainer reply",
        detail: "Draft the next negotiation reply and leave it unsent.",
        kind: "draft",
      },
      {
        key: "flag-deal-terms",
        label: "Flag deal terms",
        detail: "Pull out payment, usage, and exclusivity terms that need a decision.",
        kind: "read",
      },
    ],
  },
  {
    slug: "cling",
    name: "Cling",
    stamp: "Cl",
    role: "Scripts and slideshow text",
    group: "brand",
    summary: "Writes slideshow scripts and on-screen text from the tracker.",
    boundary: "Cling writes copy. It does not post or invoice.",
    tasks: [
      {
        key: "draft-slideshow-script",
        label: "Draft a slideshow script",
        detail: "Draft the script and slide text for the next brand deliverable.",
        kind: "draft",
      },
      {
        key: "revise-overlay-text",
        label: "Revise overlay text",
        detail: "Revise captions and on-screen lines for the current deliverable.",
        kind: "draft",
      },
      {
        key: "list-missing-copy",
        label: "List missing copy",
        detail: "List tracker rows that still need a script or overlay text.",
        kind: "read",
      },
    ],
  },
  {
    slug: "sling",
    name: "Sling",
    stamp: "Sl",
    role: "Posts brand deliverables to TikTok",
    group: "brand",
    summary: "Publishes brand files that are already in Ready to Post.",
    boundary:
      "Sling can start a posting run. TikTok sign-in and approval prompts still apply. The job is completed only when a published post URL is recorded.",
    tasks: [
      {
        key: "preview-ready-post",
        label: "Preview Ready to Post",
        detail: "List what is waiting in the brand Ready to Post folder. Do not publish.",
        kind: "read",
      },
      {
        key: "post-next-brand",
        label: "Post the next brand deliverable",
        detail: "Post the next approved brand deliverable. Completed only with a live post URL.",
        kind: "post",
      },
    ],
  },
  {
    slug: "bling",
    name: "Bling",
    stamp: "Bl",
    role: "Invoicing and payment tracking",
    group: "brand",
    summary: "Drafts invoices and checks what has been paid.",
    boundary: "Bling drafts and reconciles. It does not send an invoice email from this desk.",
    tasks: [
      {
        key: "draft-invoice",
        label: "Draft the next invoice",
        detail: "Draft the next invoice from the tracker and leave it unsent.",
        kind: "draft",
      },
      {
        key: "reconcile-payments",
        label: "Reconcile payments",
        detail: "Match recorded payments against open invoices.",
        kind: "read",
      },
      {
        key: "list-overdue",
        label: "List overdue invoices",
        detail: "List invoices that are past due and the amount still open.",
        kind: "read",
      },
    ],
  },
  {
    slug: "pling",
    name: "Pling",
    stamp: "Pl",
    role: "Performance analytics",
    group: "brand",
    summary: "Pulls views, GMV, and commissions into a scorecard.",
    boundary: "Pling reports numbers. It does not change posts or invoices.",
    tasks: [
      {
        key: "pull-performance",
        label: "Pull views, GMV, and commissions",
        detail: "Read the latest views, GMV, and commission figures and write them down.",
        kind: "read",
      },
      {
        key: "weekly-scorecard",
        label: "Write the weekly scorecard",
        detail: "Summarize the week from the tracker and the latest performance pull.",
        kind: "draft",
      },
      {
        key: "flag-outliers",
        label: "Flag outlier videos",
        detail: "Flag videos whose views or GMV sit far from the recent pattern.",
        kind: "read",
      },
    ],
  },
  {
    slug: "slack",
    name: "Slack",
    stamp: "Sk",
    role: "Standalone poster for non-brand content",
    group: "original",
    summary: "Posts original work from Postr. Slack is this agent's name, not the Slack app.",
    boundary:
      "Slack does not touch brand deliverables. A posting job is completed only when a published post URL is recorded. TikTok sign-in and approvals still apply.",
    tasks: [
      {
        key: "preview-postr",
        label: "Preview the Postr queue",
        detail: "Review Postr (Normal) and Ready to Post. Do not publish.",
        kind: "read",
      },
      {
        key: "post-next-original",
        label: "Post the next original",
        detail: "Post the next non-brand item. Completed only with a live post URL.",
        kind: "post",
      },
      {
        key: "reconcile-posted",
        label: "Reconcile Posted against the log",
        detail: "Compare the Posted folder with the Postr Log and note anything missing.",
        kind: "read",
      },
    ],
  },
];

export function agentBySlug(slug: string): AgentDef | undefined {
  return AGENTS.find((agent) => agent.slug === slug);
}

export function taskByKey(agent: AgentDef, task: string): TaskDef | undefined {
  return agent.tasks.find((item) => item.key === task);
}

export function isPostingTask(task: string): boolean {
  return AGENTS.some((agent) => agent.tasks.some((item) => item.key === task && item.kind === "post"));
}

export const JOB_STATUSES = [
  "requested",
  "running",
  "needs input",
  "completed",
  "failed",
  "unknown",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export const AGENT_STATUS_WRITES = ["running", "needs input", "completed", "failed"] as const;

export type AgentStatusWrite = (typeof AGENT_STATUS_WRITES)[number];

export const SHEET_COLUMNS = [
  "job_id",
  "agent",
  "task",
  "status",
  "output_url",
  "note",
  "updated_at",
] as const;

export const SHEET_TAB = "Automate Jobs";

export const DEFAULT_STALE_REQUESTED_MS = 15 * 60 * 1000;
export const DEFAULT_STALE_RUNNING_MS = 2 * 60 * 60 * 1000;

export const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;
export const UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
export const DRIVE_CHUNK_MULTIPLE = 256 * 1024;

export const IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
