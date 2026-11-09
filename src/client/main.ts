import {
  api,
  loadBootstrap,
  loadJobs,
  reconcileAll,
  reconcileJob,
  startJob,
  type AgentInfo,
  type Bootstrap,
  type DriveItem,
  type JobView,
} from "./api";

const MAX_FILES = 20;
const MAX_BYTES = 30 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

interface UploadRow {
  localId: string;
  name: string;
  file: File;
  progress: number;
  status: "queued" | "uploading" | "done" | "error";
  message: string;
  uploadId: string | null;
  link: string | null;
  received: number;
}

const uploads: UploadRow[] = [];
let desk: Bootstrap | null = null;
let selectedFolderKey: string | null = null;
let selectedFolderId: string | null = null;
let selectedLabel = "";

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, string> = {},
  ...children: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) node.append(child);
  return node;
}

function csrf(): string {
  const match = document.cookie.match(/(?:^|; )automate_csrf=([^;]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : "";
}

function agentPath(slug: string): string {
  return `/automate/agents/${slug}`;
}

async function boot(): Promise<void> {
  const result = await loadBootstrap();
  if (!result.ok || !result.data) {
    renderFatal(result.failure?.detail ?? "The desk could not load.");
    return;
  }
  desk = result.data;
  renderShell();
  window.addEventListener("popstate", () => {
    renderRoute();
  });
  renderRoute();
}

function renderFatal(message: string): void {
  const root = document.querySelector("#app");
  if (!root) return;
  root.replaceChildren(
    h("main", { class: "main", id: "main" }, h("h1", { class: "title" }, "Setup needed"), h("p", {}, message)),
  );
}

function renderShell(): void {
  const root = document.querySelector("#app");
  if (!root || !desk) return;
  const nav = h("nav", { class: "nav", "aria-label": "Desk" });
  nav.append(navLink("/automate", "Overview"), navLink("/automate/drive", "Drive"));
  for (const agent of desk.agents) nav.append(navLink(agentPath(agent.slug), agent.name));
  const brand = h(
    "a",
    { class: "brand", href: "/automate" },
    h("span", { class: "monogram" }, "JB"),
    h("span", {}, "Automate"),
  );
  brand.addEventListener("click", (event) => go(event, "/automate"));
  const rail = h("aside", { class: "rail" }, brand, nav);
  const main = h("div", { class: "main", id: "main" });
  root.replaceChildren(h("div", { class: "shell" }, rail, main));
}

function navLink(href: string, label: string): HTMLAnchorElement {
  const link = h("a", { class: "nav-link", href }, label);
  link.addEventListener("click", (event) => go(event, href));
  return link;
}

function go(event: Event, href: string): void {
  event.preventDefault();
  if (window.location.pathname !== href) history.pushState(null, "", href);
  renderRoute();
}

function markNav(): void {
  const path = window.location.pathname.replace(/\/$/, "") || "/automate";
  for (const link of document.querySelectorAll<HTMLAnchorElement>(".nav-link")) {
    const active = link.getAttribute("href") === path;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
}

function renderRoute(): void {
  markNav();
  const main = document.querySelector("#main");
  if (!main || !desk) return;
  const path = window.location.pathname.replace(/\/$/, "") || "/automate";
  main.replaceChildren();
  if (path === "/automate") {
    renderOverview(main);
    return;
  }
  if (path === "/automate/drive") {
    renderDrive(main);
    return;
  }
  const match = path.match(/^\/automate\/agents\/([a-z]+)$/);
  const agent = desk.agents.find((item) => item.slug === match?.[1]);
  if (agent) {
    renderAgent(main, agent);
    return;
  }
  main.append(h("h1", { class: "title" }, "Not found"), h("p", {}, "That desk page does not exist."));
}

function renderOverview(main: Element): void {
  if (!desk) return;
  main.append(
    h("p", { class: "kicker" }, "Private"),
    h("h1", { class: "title" }, "Six desks, one owner."),
    h(
      "p",
      { class: "lede" },
      "Start a saved task, watch the job, and browse Drive. Nothing on this page posts, emails, or invoices by itself.",
    ),
  );
  const notice = h("div", { id: "notice" });
  main.append(notice, checklist(desk), h("h2", { class: "section" }, "Agents"));
  const grid = h("div", { class: "agent-grid" });
  for (const agent of desk.agents) grid.append(agentCard(agent));
  main.append(grid, h("h2", { class: "section" }, "Jobs"));
  const jobs = h("div", { id: "jobs" });
  const refresh = h("button", { class: "button button-quiet", type: "button" }, "Reconcile from the sheet");
  refresh.addEventListener("click", () => {
    void refreshAll(notice, jobs);
  });
  main.append(refresh, jobs, statusLegend(desk));
  void fillJobs(jobs, null);
}

function checklist(data: Bootstrap): HTMLElement {
  const rows: Array<[string, boolean, string]> = [
    ["Sign-in", true, data.auth === "access" ? "Cloudflare Access is checking this browser." : "Local dev sign-in is on. Production should use Access."],
    ["Encryption", data.setup.encryption, "Refresh tokens stay encrypted with TOKEN_ENCRYPTION_KEY."],
    ["Google", data.setup.google === "connected", data.setup.googleEmail ? `Connected as ${data.setup.googleEmail}.` : "Connect Google from Drive. This desk cannot reuse a Grok Bot connection."],
    ["Sheet reconcile", data.setup.scopes.sheetsReadonly, "Reading Automate Jobs needs spreadsheets.readonly."],
    ["Folder browse", data.setup.scopes.driveReadonly || data.setup.scopes.drive, "Listing existing folders needs drive.readonly. drive.file plus Picker is the narrower upload path."],
    ["Callback URL", data.setup.publicBaseUrl, "PUBLIC_BASE_URL lets an agent POST a result. The sheet still works without it."],
    ["Slack sheet", data.setup.slackSheet, "SLACK_LOG_SHEET_ID is separate from the brand tracker."],
  ];
  const list = h("ul", { class: "check" });
  for (const [label, ready, detail] of rows) {
    list.append(
      h(
        "li",
        {},
        h("span", { class: ready ? "chip chip-ready" : "chip chip-need" }, ready ? "Ready" : "Setup needed"),
        h("strong", {}, label),
        h("span", { class: "muted" }, detail),
      ),
    );
  }
  return h("section", { class: "panel" }, h("h2", { class: "section" }, "Setup"), list);
}

function statusLegend(data: Bootstrap): HTMLElement {
  return h(
    "section",
    { class: "panel" },
    h("h2", { class: "section" }, "How a job moves"),
    h("p", {}, "Requested means the webhook returned 200. That accepts the run. It does not mean the task finished."),
    h("p", {}, "Running, needs input, completed, and failed are written by the agent to the sheet or the callback."),
    h("p", {}, "Unknown means the trail went cold, or a posting job came back without a live TikTok URL."),
    h(
      "p",
      {},
      `A request with no start after ${data.stale.requestedMinutes} minutes becomes unknown. A running job is marked stale after ${data.stale.runningMinutes} minutes and stays running.`,
    ),
    h(
      "p",
      {},
      "A button here does not lock a scheduled routine. Those routines have to read the same job id and skip work that is already underway.",
    ),
  );
}

function agentCard(agent: AgentInfo): HTMLElement {
  const webhook = desk?.setup.webhooks[agent.slug] ?? "setup_needed";
  const card = h(
    "a",
    { class: "agent-card", href: agentPath(agent.slug) },
    h("span", { class: "stamp", "data-agent": agent.slug }, agent.stamp),
    h("span", { class: "agent-name" }, agent.name),
    h("span", { class: "muted" }, agent.role),
    h("span", { class: webhook === "ready" ? "chip chip-ready" : "chip chip-need" }, webhook === "ready" ? "Webhook ready" : "Setup needed"),
  );
  card.addEventListener("click", (event) => go(event, agentPath(agent.slug)));
  return card;
}

function renderAgent(main: Element, agent: AgentInfo): void {
  const webhook = desk?.setup.webhooks[agent.slug] ?? "setup_needed";
  main.append(
    h("p", { class: "kicker" }, agent.group === "brand" ? "Brand desk" : "Original desk"),
    h("h1", { class: "title" }, agent.name),
    h("p", { class: "lede" }, agent.summary),
    h("div", { class: "banner" }, agent.boundary),
  );
  if (agent.slug === "slack") {
    main.append(
      h(
        "p",
        { class: "muted" },
        "Slack is the name of this poster. It is not the Slack app. Its folders are Postr (Normal), Ready to Post, and Posted.",
      ),
    );
  }
  if (webhook !== "ready") {
    main.append(
      h(
        "div",
        { class: "banner" },
        webhook === "rejected_host"
          ? "Setup needed. The webhook host is not allowlisted, so the buttons stay off."
          : "Setup needed. Add this agent's webhook URL and key on the server before a task can start.",
      ),
    );
  }
  const notice = h("div", { id: "notice", "aria-live": "polite" });
  const tasks = h("div", { class: "task-list" });
  for (const task of agent.tasks) {
    const button = h(
      "button",
      { class: "task", type: "button" },
      h("strong", {}, task.label),
      h("small", {}, task.detail),
    ) as HTMLButtonElement;
    button.disabled = webhook !== "ready";
    button.addEventListener("click", () => {
      void runTask(agent, task.key, button, notice);
    });
    tasks.append(button);
  }
  const jobs = h("div", { id: "jobs" });
  main.append(h("h2", { class: "section" }, "Tasks"), notice, tasks, h("h2", { class: "section" }, "Jobs"), jobs);
  void fillJobs(jobs, agent.slug);
}

async function runTask(agent: AgentInfo, task: string, button: HTMLButtonElement, notice: HTMLElement): Promise<void> {
  button.disabled = true;
  const key = crypto.randomUUID();
  const result = await startJob(agent.slug, task, key);
  button.disabled = (desk?.setup.webhooks[agent.slug] ?? "setup_needed") !== "ready";
  notice.replaceChildren();
  if (!result.ok || !result.data) {
    notice.append(h("div", { class: "banner" }, result.failure?.detail ?? "The task did not start."));
    return;
  }
  const job = result.data.job;
  if (job.delivery === "accepted") {
    notice.append(h("div", { class: "banner" }, "Accepted, not completed. HTTP 200 only means the run started."));
  } else if (job.error) {
    notice.append(h("div", { class: "banner" }, job.error));
  }
  const jobs = document.querySelector("#jobs");
  if (jobs) await fillJobs(jobs, agent.slug);
}

async function fillJobs(container: Element, agent: string | null): Promise<void> {
  const result = await loadJobs(agent ?? undefined);
  container.replaceChildren();
  if (!result.ok || !result.data) {
    container.append(h("p", {}, result.failure?.detail ?? "Jobs could not be loaded."));
    return;
  }
  if (result.data.jobs.length === 0) {
    container.append(h("p", { class: "muted" }, "No jobs yet. A disabled button is setup, not a finished run."));
    return;
  }
  const list = h("ul", { class: "jobs" });
  for (const job of result.data.jobs) list.append(jobRow(job));
  container.append(list);
}

function jobRow(job: JobView): HTMLElement {
  const pillClass = `status status-${job.status === "needs input" ? "needs" : job.status}`;
  const top = h(
    "div",
    { class: "job-top" },
    h("strong", {}, job.taskLabel),
    h("span", { class: pillClass }, job.status),
  );
  if (job.stale) top.append(h("span", { class: "status status-stale" }, "Stale"));
  const row = h("li", { class: "job" }, top, h("p", { class: "muted" }, `${job.agent} · ${when(job.updatedAt)}`));
  if (job.delivery === "accepted" && job.status === "requested") {
    row.append(h("p", {}, "Accepted, not completed."));
  }
  if (job.error) row.append(h("p", {}, job.error));
  if (job.note) row.append(h("p", {}, job.note));
  if (job.outputUrl && job.outputUrl.startsWith("https://")) {
    const link = h("a", { href: job.outputUrl, target: "_blank", rel: "noopener noreferrer" }, "Open output");
    row.append(link);
  }
  if (job.runUuid) row.append(h("p", { class: "muted" }, `Run ${job.runUuid}`));
  const actions = h("div", { class: "row-actions" });
  const refresh = h("button", { class: "button button-quiet", type: "button" }, "Reconcile");
  refresh.addEventListener("click", () => {
    void (async () => {
      const result = await reconcileJob(job.id);
      const host = row.parentElement?.parentElement;
      if (host) await fillJobs(host, job.agent === window.location.pathname.split("/").pop() ? job.agent : null);
      if (!result.ok) row.append(h("p", {}, result.failure?.detail ?? "Reconcile failed."));
      else if (result.data?.detail) row.append(h("p", { class: "muted" }, result.data.detail));
    })();
  });
  actions.append(refresh);
  if (job.status !== "completed") {
    const manual = h("button", { class: "button button-quiet", type: "button" }, "Mark unknown");
    manual.addEventListener("click", () => {
      void markUnknown(job.id, row);
    });
    actions.append(manual);
  }
  row.append(actions);
  return row;
}

async function markUnknown(id: string, row: HTMLElement): Promise<void> {
  const result = await reconcileJob(id, { action: "set", status: "unknown", note: "Marked unknown by the owner." });
  if (!result.ok) {
    row.append(h("p", {}, result.failure?.detail ?? "That status was not saved."));
    return;
  }
  const host = row.parentElement?.parentElement;
  if (host) await fillJobs(host, null);
}

async function refreshAll(notice: HTMLElement, jobs: HTMLElement): Promise<void> {
  const result = await reconcileAll();
  notice.replaceChildren();
  if (!result.ok || !result.data) {
    notice.append(h("div", { class: "banner" }, result.failure?.detail ?? "Reconcile did not run."));
    return;
  }
  const pending = result.data.sheets.filter((sheet) => sheet.sheet === "setup_needed" || sheet.sheet === "error");
  if (pending.length > 0) {
    notice.append(h("div", { class: "banner" }, pending.map((sheet) => sheet.detail ?? `${sheet.agentGroup}: setup needed`).join(" ")));
  }
  await fillJobs(jobs, null);
}

function when(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

function renderDrive(main: Element): void {
  if (!desk) return;
  const params = new URLSearchParams(window.location.search);
  const googleFlag = params.get("google");
  main.append(h("p", { class: "kicker" }, "Drive"), h("h1", { class: "title" }, "Folders and photos"), h("p", { class: "lede" }, "Browse the allowlisted folders, or drop photos into one of them. Uploads are not TikTok posts."));
  if (googleFlag === "connected") main.append(h("div", { class: "banner" }, "Google connected."));
  if (googleFlag === "denied" || googleFlag === "error" || googleFlag === "state") {
    main.append(h("div", { class: "banner" }, "Google did not connect. No upload was sent."));
  }
  if (!desk.setup.scopes.driveReadonly && !desk.setup.scopes.drive) {
    main.append(
      h(
        "div",
        { class: "banner" },
        "Browsing Brands and Ready to Post needs drive.readonly. drive.file can still upload into a folder you created with this app or opened with Google Picker. The setup guide records that trade-off.",
      ),
    );
  }
  const googleRow = h("div", { class: "row-actions" });
  if (desk.setup.google === "connected") {
    googleRow.append(h("span", { class: "chip chip-ready" }, desk.setup.googleEmail ?? "Connected"));
    const disconnect = h("button", { class: "button button-quiet", type: "button" }, "Disconnect Google");
    disconnect.addEventListener("click", () => {
      void disconnectGoogle();
    });
    googleRow.append(disconnect);
  } else if (desk.setup.googleOauth) {
    const connect = h("button", { class: "button", type: "button" }, "Connect Google");
    connect.addEventListener("click", () => {
      void connectGoogle();
    });
    googleRow.append(connect);
  } else {
    googleRow.append(h("span", { class: "chip chip-need" }, "Setup needed"));
  }
  if (desk.picker && desk.setup.google === "connected") {
    const pick = h("button", { class: "button button-quiet", type: "button" }, "Open a folder with Picker");
    pick.addEventListener("click", () => {
      void openPicker();
    });
    googleRow.append(pick);
  }
  main.append(googleRow);
  const layout = h("div", { class: "drive" });
  const side = h("section", { class: "panel" });
  side.append(h("h2", { class: "section" }, "Upload destination"));
  const choices = h("div", { class: "dest" });
  for (const folder of desk.folders) {
    const button = h("button", { class: "task", type: "button" }, h("strong", {}, folder.label), h("small", {}, folder.configured ? folder.group : "Setup needed")) as HTMLButtonElement;
    button.disabled = !folder.configured || desk.setup.google !== "connected";
    button.addEventListener("click", () => {
      selectedFolderKey = folder.key;
      selectedFolderId = null;
      selectedLabel = folder.label;
      for (const peer of choices.querySelectorAll("button")) peer.classList.remove("selected");
      button.classList.add("selected");
      dropHint.textContent = `Drop photos for ${folder.label}.`;
      void showFolder(browser, folder.key, null);
    });
    choices.append(button);
  }
  const drop = h("div", { class: "drop", tabindex: "0" }, "Drop photos here, or choose files.");
  const input = h("input", { type: "file", accept: "image/jpeg,image/png,image/webp,image/gif", multiple: "true" }) as HTMLInputElement;
  input.className = "file-input";
  const dropHint = h("p", { class: "muted" }, "Choose a destination before uploading.");
  drop.append(input);
  drop.addEventListener("click", () => input.click());
  drop.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") input.click();
  });
  drop.addEventListener("dragover", (event) => {
    event.preventDefault();
    drop.classList.add("hot");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("hot"));
  drop.addEventListener("drop", (event) => {
    event.preventDefault();
    drop.classList.remove("hot");
    if (event.dataTransfer) takeFiles(event.dataTransfer.files, queue, dropHint);
  });
  input.addEventListener("change", () => {
    if (input.files) takeFiles(input.files, queue, dropHint);
    input.value = "";
  });
  const queue = h("ul", { class: "uploads", "aria-live": "polite" });
  side.append(choices, dropHint, drop, queue);
  const browser = h("section", { class: "panel browser" });
  browser.append(h("h2", { class: "section" }, "Browser"), h("p", { class: "muted" }, "Select a folder to list it."));
  layout.append(side, browser);
  main.append(layout);
  renderUploadQueue(queue);
}

async function connectGoogle(): Promise<void> {
  const result = await api<{ url: string }>("/api/automate/google/start", { method: "POST", body: "{}" });
  if (!result.ok || !result.data?.url) {
    alert(result.failure?.detail ?? "Google setup is incomplete.");
    return;
  }
  window.location.href = result.data.url;
}

async function disconnectGoogle(): Promise<void> {
  await api("/api/automate/google/disconnect", { method: "POST", body: "{}" });
  window.location.href = "/automate/drive";
}

async function openPicker(): Promise<void> {
  if (!desk?.picker) return;
  const token = await api<{ accessToken: string }>("/api/automate/google/picker-token");
  if (!token.ok || !token.data) {
    window.alert(token.failure?.detail ?? "Picker needs a connected Google account.");
    return;
  }
  await loadPickerScript();
  const gapi = (window as unknown as { gapi?: { load(api: string, callback: () => void): void } }).gapi;
  const googleApi = (window as unknown as { google?: PickerGoogle }).google;
  if (!gapi || !googleApi) {
    window.alert("Google Picker did not load.");
    return;
  }
  await new Promise<void>((resolve) => gapi.load("picker", resolve));
  const view = new googleApi.picker.DocsView(googleApi.picker.ViewId.FOLDERS);
  view.setSelectFolderEnabled(true);
  view.setMimeTypes("application/vnd.google-apps.folder");
  const picker = new googleApi.picker.PickerBuilder()
    .setAppId(desk.picker.appId)
    .setOAuthToken(token.data.accessToken)
    .setDeveloperKey(desk.picker.apiKey)
    .addView(view)
    .setCallback((data) => {
      if (data.action === googleApi.picker.Action.PICKED && data.docs?.[0]?.id) {
        void acceptPickedFolder(data.docs[0].id);
      }
    })
    .build();
  picker.setVisible(true);
}

async function acceptPickedFolder(folderId: string): Promise<void> {
  const result = await api<{ folderId: string; folderKey: string; label: string }>("/api/automate/drive/open", {
    method: "POST",
    body: JSON.stringify({ folderId }),
  });
  if (!result.ok || !result.data) {
    alert(result.failure?.detail ?? "That folder is not on the allowlist.");
    return;
  }
  selectedFolderKey = null;
  selectedFolderId = result.data.folderId;
  selectedLabel = result.data.label;
  const browser = document.querySelector(".browser");
  if (browser) await showFolder(browser, null, result.data.folderId);
}

function loadPickerScript(): Promise<void> {
  if (document.querySelector("script[data-picker]")) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://apis.google.com/js/api.js";
    script.async = true;
    script.dataset.picker = "1";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("picker"));
    document.head.append(script);
  });
}

async function showFolder(browser: Element, key: string | null, folderId: string | null): Promise<void> {
  const query = key ? `key=${encodeURIComponent(key)}` : `folderId=${encodeURIComponent(folderId ?? "")}`;
  const result = await api<{
    label: string;
    items: DriveItem[];
    breadcrumb: Array<{ id: string; name: string }>;
  }>(`/api/automate/drive/list?${query}`);
  browser.replaceChildren(h("h2", { class: "section" }, "Browser"));
  if (!result.ok || !result.data) {
    browser.append(h("div", { class: "banner" }, result.failure?.detail ?? "This folder cannot be listed."));
    return;
  }
  const crumbs = h("div", { class: "crumbs" });
  for (const crumb of result.data.breadcrumb) {
    const button = h("button", { class: "button button-quiet", type: "button" }, crumb.name);
    button.addEventListener("click", () => {
      selectedFolderId = crumb.id;
      selectedFolderKey = null;
      selectedLabel = crumb.name;
      void showFolder(browser, null, crumb.id);
    });
    crumbs.append(button);
  }
  const grid = h("div", { class: "grid" });
  const images = result.data.items.filter((item) => item.kind === "image");
  if (result.data.items.length === 0) {
    browser.append(crumbs, h("p", { class: "muted" }, "This folder has nothing the current Google grant can see."));
    return;
  }
  for (const item of result.data.items) grid.append(tile(item, images, browser));
  browser.append(crumbs, grid);
}

function tile(item: DriveItem, images: DriveItem[], browser: Element): HTMLElement {
  if (item.kind === "folder") {
    const button = h("button", { class: "tile", type: "button" }, h("span", { class: "folder-mark" }, "Folder"), h("span", {}, item.name));
    button.addEventListener("click", () => {
      selectedFolderId = item.id;
      selectedFolderKey = null;
      selectedLabel = item.name;
      void showFolder(browser, null, item.id);
    });
    return button;
  }
  if (item.kind === "image") {
    const img = h("img", { alt: item.name, src: `/api/automate/drive/files/${encodeURIComponent(item.id)}/thumb` }) as HTMLImageElement;
    const button = h("button", { class: "tile", type: "button" }, img, h("span", {}, item.name));
    button.addEventListener("click", () => openSlideshow(images, item.id));
    return button;
  }
  return h("div", { class: "tile file" }, h("span", { class: "folder-mark" }, "File"), h("span", {}, item.name));
}

function openSlideshow(images: DriveItem[], currentId: string): void {
  let index = Math.max(0, images.findIndex((item) => item.id === currentId));
  const dialog = h("dialog", { class: "player" }) as HTMLDialogElement;
  const img = h("img", { alt: "" }) as HTMLImageElement;
  const caption = h("p", {});
  const prev = h("button", { class: "button button-quiet", type: "button" }, "Previous");
  const next = h("button", { class: "button button-quiet", type: "button" }, "Next");
  const close = h("button", { class: "button", type: "button" }, "Close");
  const show = (): void => {
    const item = images[index];
    if (!item) return;
    img.src = `/api/automate/drive/files/${encodeURIComponent(item.id)}/preview`;
    img.alt = item.name;
    caption.textContent = `${index + 1} of ${images.length} · ${item.name}`;
  };
  prev.addEventListener("click", () => {
    index = (index - 1 + images.length) % images.length;
    show();
  });
  next.addEventListener("click", () => {
    index = (index + 1) % images.length;
    show();
  });
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => dialog.remove());
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "ArrowRight") next.click();
    if (event.key === "ArrowLeft") prev.click();
  });
  dialog.append(img, caption, h("div", { class: "row-actions" }, prev, next, close));
  document.body.append(dialog);
  show();
  dialog.showModal();
}

function takeFiles(list: FileList, queue: HTMLElement, hint: HTMLElement): void {
  if (!selectedFolderKey && !selectedFolderId) {
    hint.textContent = "Choose a destination before uploading.";
    return;
  }
  if (desk?.setup.google !== "connected") {
    hint.textContent = "Setup needed. Connect Google before uploading.";
    return;
  }
  hint.textContent = selectedLabel ? `Uploading to ${selectedLabel}.` : "Uploading.";
  const incoming = [...list];
  if (incoming.length > MAX_FILES) {
    hint.textContent = `Choose up to ${MAX_FILES} photos at a time.`;
    return;
  }
  for (const file of incoming) {
    const row: UploadRow = {
      localId: crypto.randomUUID(),
      name: file.name,
      file,
      progress: 0,
      status: "queued",
      message: "",
      uploadId: null,
      link: null,
      received: 0,
    };
    if (!IMAGE_TYPES.has(file.type)) {
      row.status = "error";
      row.message = "Use jpeg, png, webp, or gif.";
    } else if (file.size <= 0 || file.size > MAX_BYTES) {
      row.status = "error";
      row.message = "Each photo must be 30 MB or smaller.";
    }
    uploads.push(row);
    if (row.status === "queued") void sendFile(row, queue);
  }
  renderUploadQueue(queue);
}

function renderUploadQueue(queue: HTMLElement): void {
  queue.replaceChildren();
  for (const row of uploads) {
    const item = h("li", { class: "file-row" }, h("strong", {}, row.name), h("span", {}, statusLine(row)));
    const bar = h("div", { class: "bar" }, h("span", { style: `width:${Math.round(row.progress)}%` }));
    item.append(bar);
    if (row.link) item.append(h("a", { href: row.link, target: "_blank", rel: "noopener noreferrer" }, "Open in Drive"));
    if (row.status === "error") {
      const retry = h("button", { class: "button button-quiet", type: "button" }, "Retry");
      retry.addEventListener("click", () => {
        row.status = "queued";
        row.message = "";
        void sendFile(row, queue);
      });
      item.append(retry);
    }
    queue.append(item);
  }
}

function statusLine(row: UploadRow): string {
  if (row.status === "uploading" || row.status === "queued") return `${Math.round(row.progress)}%`;
  if (row.status === "done") return "Uploaded";
  return row.message || "Failed";
}

async function sendFile(row: UploadRow, queue: HTMLElement): Promise<void> {
  row.status = "uploading";
  renderUploadQueue(queue);
  if (!row.uploadId) {
    const started = await api<{ uploadId: string; chunkSize: number; total: number }>("/api/automate/drive/uploads", {
      method: "POST",
      body: JSON.stringify({
        folderKey: selectedFolderKey,
        folderId: selectedFolderId,
        name: row.file.name,
        mimeType: row.file.type,
        size: row.file.size,
      }),
    });
    if (!started.ok || !started.data) {
      row.status = "error";
      row.message = started.failure?.detail ?? "Upload did not start.";
      renderUploadQueue(queue);
      return;
    }
    row.uploadId = started.data.uploadId;
    await pump(row, started.data.chunkSize, queue);
    return;
  }
  const probe = await api<{ restart?: boolean; received: number }>(`/api/automate/drive/uploads/${row.uploadId}/retry`, {
    method: "POST",
    body: "{}",
  });
  if (!probe.ok || probe.data?.restart) {
    row.uploadId = null;
    row.received = 0;
    await sendFile(row, queue);
    return;
  }
  row.received = probe.data?.received ?? row.received;
  await pump(row, 4 * 1024 * 1024, queue);
}

async function pump(row: UploadRow, chunkSize: number, queue: HTMLElement): Promise<void> {
  let offset = row.received;
  while (offset < row.file.size) {
    const end = Math.min(offset + chunkSize, row.file.size);
    const chunk = row.file.slice(offset, end);
    const result = await putChunk(row.uploadId ?? "", chunk, offset, end - 1, row.file.size, (loaded) => {
      row.progress = (loaded / row.file.size) * 100;
      renderUploadQueue(queue);
    });
    if (!result.ok) {
      row.status = "error";
      row.message = result.failure?.detail ?? "Upload failed.";
      renderUploadQueue(queue);
      return;
    }
    const body = result.data as { received?: number; status?: string; webViewLink?: string | null };
    offset = body.received ?? end;
    row.received = offset;
    row.progress = (offset / row.file.size) * 100;
    if (body.status === "complete") {
      row.status = "done";
      row.link = body.webViewLink ?? null;
      row.progress = 100;
      renderUploadQueue(queue);
      return;
    }
  }
  row.status = "done";
  row.progress = 100;
  renderUploadQueue(queue);
}

function putChunk(
  uploadId: string,
  blob: Blob,
  start: number,
  end: number,
  total: number,
  onProgress: (loaded: number) => void,
): Promise<{ ok: boolean; data: unknown; failure: { detail?: string } | null }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `/api/automate/drive/uploads/${uploadId}`);
    xhr.setRequestHeader("content-range", `bytes ${start}-${end}/${total}`);
    xhr.setRequestHeader("x-automate-csrf", csrf());
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(start + event.loaded);
    };
    xhr.onload = () => {
      let data: unknown = null;
      try {
        data = JSON.parse(xhr.responseText) as unknown;
      } catch {
        data = null;
      }
      const record = data as { detail?: string; error?: string } | null;
      resolve({
        ok: xhr.status >= 200 && xhr.status < 300,
        data,
        failure: xhr.status >= 200 && xhr.status < 300 ? null : { detail: record?.detail ?? record?.error ?? "Upload failed." },
      });
    };
    xhr.onerror = () => resolve({ ok: false, data: null, failure: { detail: "The upload request failed before a response." } });
    xhr.send(blob);
  });
}

interface PickerGoogle {
  picker: {
    DocsView: new (viewId: string) => {
      setSelectFolderEnabled(enabled: boolean): void;
      setMimeTypes(types: string): void;
    };
    ViewId: { FOLDERS: string };
    Action: { PICKED: string };
    PickerBuilder: new () => PickerBuilder;
  };
}

interface PickerBuilder {
  setAppId(id: string): PickerBuilder;
  setOAuthToken(token: string): PickerBuilder;
  setDeveloperKey(key: string): PickerBuilder;
  addView(view: unknown): PickerBuilder;
  setCallback(callback: (data: { action: string; docs?: Array<{ id: string }> }) => void): PickerBuilder;
  build(): { setVisible(visible: boolean): void };
}

boot().catch(() => renderFatal("The desk could not load."));
