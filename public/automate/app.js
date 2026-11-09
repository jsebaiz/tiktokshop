// src/client/api.ts
function csrfToken() {
  const match = document.cookie.match(/(?:^|; )automate_csrf=([^;]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : "";
}
async function api(path, init = {}) {
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
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  if (!response.ok) {
    const failure = parsed ?? { error: "request_failed" };
    return { ok: false, status: response.status, data: null, failure };
  }
  return { ok: true, status: response.status, data: parsed, failure: null };
}
function loadBootstrap() {
  return api("/api/automate/bootstrap");
}
function loadJobs(agent) {
  const query = agent ? `?agent=${encodeURIComponent(agent)}` : "";
  return api(`/api/automate/jobs${query}`);
}
function startJob(agent, task, idempotencyKey) {
  return api("/api/automate/jobs", {
    method: "POST",
    body: JSON.stringify({ agent, task, idempotencyKey })
  });
}
function reconcileJob(id, body = { action: "refresh" }) {
  return api(`/api/automate/jobs/${id}/reconcile`, { method: "POST", body: JSON.stringify(body) });
}
function reconcileAll() {
  return api("/api/automate/jobs/reconcile", { method: "POST", body: "{}" });
}

// src/shared/progress.ts
var XP_PER_LEVEL = 3;
function levelProgress(completed) {
  const done = Number.isFinite(completed) && completed > 0 ? Math.floor(completed) : 0;
  return {
    level: 1 + Math.floor(done / XP_PER_LEVEL),
    current: done % XP_PER_LEVEL,
    goal: XP_PER_LEVEL
  };
}
function doneThisWeek(isoTimes, nowMs) {
  const week = 7 * 864e5;
  return isoTimes.filter((iso) => {
    const time = Date.parse(iso);
    return !Number.isNaN(time) && time <= nowMs && nowMs - time <= week;
  }).length;
}
function completionStreak(isoTimes, nowMs) {
  const days = /* @__PURE__ */ new Set();
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
function shiftDay(day, delta) {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + delta * 864e5).toISOString().slice(0, 10);
}
function jobTone(status, stale) {
  if (status === "failed" || status === "needs input") return "red";
  if (status === "unknown" || stale) return "amber";
  if (status === "completed") return "green";
  return "blue";
}
function attentionRank(status, stale) {
  if (status === "failed") return 0;
  if (status === "needs input") return 1;
  if (status === "unknown" || stale) return 2;
  return null;
}
function statusLabel(status, stale) {
  if (status === "needs input") return "Needs you";
  if (status === "failed") return "Failed";
  if (stale) return "Stale";
  if (status === "unknown") return "Unknown";
  if (status === "running") return "Running";
  if (status === "requested") return "Accepted";
  if (status === "completed") return "Done";
  return "Check";
}
var SHORT_TASK = {
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
  "reconcile-posted": "Posted check"
};
function shortTask(task, fallback) {
  return SHORT_TASK[task] ?? fallback.split(/\s+/).slice(0, 3).join(" ");
}
function jobSummary(task, taskLabel, status, stale) {
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

// src/client/main.ts
var MAX_FILES = 20;
var MAX_BYTES = 30 * 1024 * 1024;
var IMAGE_TYPES = /* @__PURE__ */ new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
var uploads = [];
var desk = null;
var selectedFolderKey = null;
var selectedFolderId = null;
var selectedLabel = "";
function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) node.append(child);
  return node;
}
function csrf() {
  const match = document.cookie.match(/(?:^|; )automate_csrf=([^;]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : "";
}
function agentPath(slug) {
  return `/automate/agents/${slug}`;
}
async function boot() {
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
function renderFatal(message) {
  const root = document.querySelector("#app");
  if (!root) return;
  root.replaceChildren(
    h("main", { class: "main", id: "main" }, h("h1", { class: "title" }, "Setup needed"), h("p", {}, message))
  );
}
function renderShell() {
  const root = document.querySelector("#app");
  if (!root || !desk) return;
  const nav = h("nav", { class: "nav", "aria-label": "Desk" });
  nav.append(navLink("/automate", "Crew"), navLink("/automate/drive", "Drive"));
  for (const agent of desk.agents) nav.append(navLink(agentPath(agent.slug), agent.name, agent.slug));
  const brand = h(
    "a",
    { class: "brand", href: "/automate" },
    h("span", { class: "monogram" }, "JB"),
    h("span", {}, "Automate")
  );
  brand.addEventListener("click", (event) => go(event, "/automate"));
  const rail = h("aside", { class: "rail" }, brand, nav);
  const main = h("div", { class: "main", id: "main" });
  root.replaceChildren(h("div", { class: "shell" }, rail, main));
}
function navLink(href, label, agent) {
  const link = h("a", { class: "nav-link", href }, label);
  if (agent) link.dataset.agent = agent;
  link.addEventListener("click", (event) => go(event, href));
  return link;
}
function go(event, href) {
  event.preventDefault();
  if (window.location.pathname !== href) history.pushState(null, "", href);
  renderRoute();
}
function markNav() {
  const path = window.location.pathname.replace(/\/$/, "") || "/automate";
  for (const link of document.querySelectorAll(".nav-link")) {
    const active = link.getAttribute("href") === path;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
}
function renderRoute() {
  markNav();
  const main = document.querySelector("#main");
  if (!(main instanceof HTMLElement) || !desk) return;
  const path = window.location.pathname.replace(/\/$/, "") || "/automate";
  main.replaceChildren();
  if (path === "/automate") {
    main.dataset.paint = "overview";
    void paintOverview(main);
    return;
  }
  if (path === "/automate/drive") {
    renderDrive(main);
    return;
  }
  const match = path.match(/^\/automate\/agents\/([a-z]+)$/);
  const agent = desk.agents.find((item) => item.slug === match?.[1]);
  if (agent) {
    main.dataset.paint = agent.slug;
    void paintAgent(main, agent);
    return;
  }
  main.append(h("h1", { class: "title" }, "Not found"), h("p", {}, "That desk page does not exist."));
}
async function paintOverview(main) {
  const result = await loadJobs();
  if (!main.isConnected || main.dataset.paint !== "overview" || !desk) return;
  const jobs = result.ok && result.data ? result.data.jobs : [];
  const jobError = result.ok ? null : result.failure?.detail ?? "Jobs could not be loaded.";
  const notice = h("div", { id: "notice", "aria-live": "polite" });
  main.replaceChildren(hero(jobs), questBlock(desk), notice, needsStrip(jobs), crewGrid(jobs), recentBlock(jobs, jobError, notice));
}
function hero(jobs) {
  const done = jobs.filter((job) => job.status === "completed");
  const progress = levelProgress(done.length);
  const streak = completionStreak(done.map((job) => job.updatedAt), Date.now());
  const title = h("div", { class: "level-line" }, playerBadge(), h("h1", { class: "title" }, `Level ${progress.level}`));
  const needs = jobs.filter((job) => attentionRank(job.status, job.stale) !== null).length;
  const running = jobs.filter((job) => job.status === "running").length;
  const week = doneThisWeek(done.map((job) => job.updatedAt), Date.now());
  const stats = h(
    "div",
    { class: "hero-stats" },
    h("p", { class: "kicker" }, "Crew"),
    title,
    h(
      "div",
      { class: "stat-row" },
      h("span", {}, `${done.length} done \xB7 ${streak}-day streak`),
      h("span", { class: "meter-label" }, `${progress.current} / next level`)
    ),
    xpBar(progress.current, progress.goal, `${progress.current} of ${progress.goal} toward the next level`, "player")
  );
  const tiles = h(
    "div",
    { class: "stat-tiles" },
    statTile(running, "Running"),
    statTile(needs, "Needs you"),
    statTile(week, "Done this week")
  );
  return h("header", { class: "hero" }, stats, tiles);
}
function statTile(value, label) {
  return h("div", { class: "stat-tile" }, h("strong", {}, String(value)), h("span", {}, label));
}
function questBlock(data) {
  const items = questItems(data);
  const ready = items.filter((item) => item.ready).length;
  const list = h("ul", { class: "quest-list" });
  for (const item of items) {
    list.append(h("li", {}, tick(item.ready), h("span", {}, item.label)));
  }
  const card = fold("Quest details", list);
  card.classList.add("quest-card");
  const summary = card.querySelector("summary");
  const mini = h("span", { class: "quest-mini" });
  const track = h("span", { class: "mini-track", "aria-hidden": "true" });
  track.append(h("span", { class: fillWidth(items.length === 0 ? 0 : ready / items.length * 100) }));
  mini.append(track, h("span", {}, `${ready}/${items.length}`));
  summary?.append(mini);
  return card;
}
function needsStrip(jobs) {
  const urgent = jobs.filter((job) => attentionRank(job.status, job.stale) !== null).sort((a, b) => (attentionRank(a.status, a.stale) ?? 9) - (attentionRank(b.status, b.stale) ?? 9));
  const questOpen = desk ? questItems(desk).some((item) => !item.ready) : false;
  const count = urgent.length + (questOpen ? 1 : 0);
  const tone = urgent.some((job) => jobTone(job.status, job.stale) === "red") ? "red" : count === 0 ? "green" : "amber";
  const strip = h("section", { class: `needs-banner banner-${tone}`, "aria-label": "Needs you" });
  const head = h("div", { class: "banner-head" }, h("h2", {}, "Needs you"), h("span", { class: "count-badge" }, String(count)));
  strip.append(head);
  if (count === 0) {
    strip.append(h("p", { class: "all-clear" }, chip("green", "All clear"), h("span", {}, "Nothing is waiting.")));
    return strip;
  }
  const list = h("ul", { class: "need-list" });
  for (const job of urgent) list.append(needJob(job));
  if (questOpen) list.append(attentionRow("amber", "Setup", "Setup quest is open", h("p", {}, "Open Quest details for the remaining steps.")));
  strip.append(list);
  return strip;
}
function needJob(job) {
  const tone = jobTone(job.status, job.stale);
  return attentionRow(tone, statusLabel(job.status, job.stale), jobSummary(job.task, job.taskLabel, job.status, job.stale), jobDetails(job));
}
function attentionRow(tone, chipLabel, summary, extra) {
  const row = h("li", { class: "need-row" }, statusMark(tone), h("span", { class: "need-line" }, summary), chip(tone, chipLabel));
  const details = document.createElement("details");
  details.className = "need-more";
  const label = document.createElement("summary");
  label.setAttribute("aria-label", "More");
  label.append(chevron());
  details.append(label, extra);
  row.append(details);
  return row;
}
function crewGrid(jobs) {
  const grid = h("div", { class: "agent-grid" });
  for (const agent of desk?.agents ?? []) grid.append(agentCard(agent, jobs.filter((job) => job.agent === agent.slug)));
  return grid;
}
function agentCard(agent, jobs) {
  const done = jobs.filter((job) => job.status === "completed").length;
  const progress = levelProgress(done);
  const card = h("a", { class: "agent-card", href: agentPath(agent.slug), "data-agent": agent.slug });
  const flag = cardFlag(agent, jobs);
  if (flag) {
    flag.classList.add("card-flag");
    card.append(flag);
  }
  card.append(
    medallion(agent.slug),
    h("span", { class: "agent-name" }, agent.name),
    h("span", { class: "role" }, shortRole(agent)),
    h(
      "div",
      { class: "stat-row" },
      h("span", {}, `Lv ${progress.level} \xB7 ${done} done`),
      h("span", { class: "meter-label" }, `${progress.current} / next level`)
    ),
    xpBar(progress.current, progress.goal, `${agent.name} level progress`, agent.slug)
  );
  card.addEventListener("click", (event) => go(event, agentPath(agent.slug)));
  return card;
}
function cardFlag(agent, jobs) {
  const urgent = jobs.filter((job) => attentionRank(job.status, job.stale) !== null).sort((a, b) => (attentionRank(a.status, a.stale) ?? 9) - (attentionRank(b.status, b.stale) ?? 9))[0];
  if (urgent) return chip(jobTone(urgent.status, urgent.stale), statusLabel(urgent.status, urgent.stale));
  if ((desk?.setup.webhooks[agent.slug] ?? "setup_needed") !== "ready") return chip("amber", "Setup");
  return null;
}
function recentBlock(jobs, jobError, notice) {
  const block = h("section", { class: "panel-card recent" }, h("div", { class: "banner-head" }, h("h2", {}, "Recent"), reconcileButton(notice)));
  block.append(notice);
  if (jobError) block.append(h("p", {}, jobError));
  else if (jobs.length === 0) block.append(h("p", { class: "empty" }, "No jobs yet."));
  else {
    const list = h("ul", { class: "need-list" });
    for (const job of jobs.slice(0, 4)) list.append(needJob(job));
    block.append(list);
  }
  return block;
}
function reconcileButton(notice) {
  const button = h("button", { class: "pill", type: "button" }, "Reconcile");
  button.addEventListener("click", () => {
    pop(button);
    void refreshAll(notice);
  });
  return button;
}
async function paintAgent(main, agent) {
  const result = await loadJobs(agent.slug);
  if (!main.isConnected || main.dataset.paint !== agent.slug || !desk) return;
  const jobs = result.ok && result.data ? result.data.jobs : [];
  const jobError = result.ok ? null : result.failure?.detail ?? "Jobs could not be loaded.";
  const webhook = desk.setup.webhooks[agent.slug] ?? "setup_needed";
  const notice = h("div", { id: "notice", "aria-live": "polite" });
  const done = jobs.filter((job) => job.status === "completed");
  const progress = levelProgress(done.length);
  const head = h(
    "header",
    { class: "hero agent-hero", "data-agent": agent.slug },
    medallion(agent.slug),
    h(
      "div",
      { class: "agent-head-copy" },
      h("p", { class: "kicker" }, shortRole(agent)),
      h("div", { class: "name-line" }, h("h1", { class: "title" }, agent.name), webhook !== "ready" ? chip("amber", "Setup") : h("span", {})),
      h(
        "div",
        { class: "stat-row" },
        h("span", {}, `Lv ${progress.level} \xB7 ${done.length} done \xB7 ${completionStreak(done.map((job) => job.updatedAt), Date.now())}-day streak`),
        h("span", { class: "meter-label" }, `${progress.current} / next level`)
      ),
      xpBar(progress.current, progress.goal, `${agent.name} level progress`, agent.slug)
    )
  );
  head.dataset.agent = agent.slug;
  const tasks = h("div", { class: "task-grid" });
  for (const task of agent.tasks) {
    const name = shortTask(task.key, task.label);
    const locked = webhook !== "ready";
    const button = h(
      "button",
      { class: "start", type: "button" },
      locked ? lockIcon() : arrowIcon(),
      h("span", {}, locked ? "Locked" : "Start")
    );
    button.disabled = locked;
    button.addEventListener("click", () => {
      pop(button);
      void runTask(agent, task.key, button, notice);
    });
    const tile2 = h(
      "div",
      { class: locked ? "task-tile is-locked" : "task-tile", "data-agent": agent.slug },
      taskGlyph(task.kind),
      h("div", { class: "task-copy" }, h("strong", {}, name), h("p", { class: "task-blurb" }, task.detail)),
      button,
      infoToggle(name, task.detail)
    );
    tasks.append(tile2);
  }
  const rules = fold(
    "Rules",
    h("p", {}, agent.boundary),
    h("p", {}, agent.slug === "slack" ? "Slack is this poster's name, not the Slack app." : "A 200 from the webhook means accepted, not finished."),
    h("p", {}, webhook === "rejected_host" ? "The webhook host is not allowlisted, so Start stays off." : "Start stays off until this agent's webhook is configured."),
    h("p", {}, "Full prompts are in the setup guide. A button here does not lock a scheduled routine.")
  );
  rules.classList.add("rules");
  const jobsBlock = h("section", { class: "panel-card activity", "data-agent": agent.slug }, h("h2", {}, "Jobs"), notice);
  if (jobError) jobsBlock.append(h("p", { class: "empty-card" }, jobError));
  else if (jobs.length === 0) jobsBlock.append(h("p", { class: "empty-card" }, "No jobs yet. A finished task will land here."));
  else {
    const list = h("ul", { class: "need-list", id: "jobs" });
    for (const job of jobs) list.append(needJob(job));
    jobsBlock.append(list);
  }
  const left = h("div", { class: "task-col" }, tasks, rules);
  main.replaceChildren(head, h("div", { class: "agent-layout" }, left, jobsBlock));
}
async function runTask(agent, task, button, notice) {
  button.disabled = true;
  const key = crypto.randomUUID();
  const result = await startJob(agent.slug, task, key);
  button.disabled = (desk?.setup.webhooks[agent.slug] ?? "setup_needed") !== "ready";
  notice.replaceChildren();
  if (!result.ok || !result.data) {
    notice.append(chip("red", "Failed"), h("span", {}, result.failure?.detail ?? "The task did not start."));
    return;
  }
  const job = result.data.job;
  const main = document.querySelector("#main");
  if (main instanceof HTMLElement && main.dataset.paint === agent.slug) await paintAgent(main, agent);
  const live = document.querySelector("#notice");
  live?.append(chip(jobTone(job.status, job.stale), statusLabel(job.status, job.stale)), h("span", {}, jobSummary(job.task, job.taskLabel, job.status, job.stale)));
}
async function refreshAll(notice) {
  const result = await reconcileAll();
  notice.replaceChildren();
  if (!result.ok || !result.data) {
    notice.append(chip("red", "Failed"), h("span", {}, result.failure?.detail ?? "Reconcile did not run."));
    return;
  }
  const pending = result.data.sheets.find((sheet) => sheet.sheet === "setup_needed" || sheet.sheet === "error");
  if (pending) notice.append(chip("amber", "Setup"), h("span", {}, pending.detail ?? "Sheet reconcile needs setup."));
  const main = document.querySelector("#main");
  if (main instanceof HTMLElement && main.dataset.paint === "overview") await paintOverview(main);
}
function jobDetails(job) {
  const bits = [h("p", {}, `${job.agent} \xB7 ${when(job.updatedAt)}`)];
  if (job.delivery === "accepted" && job.status === "requested") bits.push(h("p", {}, "Accepted, not completed."));
  if (job.error) bits.push(h("p", {}, job.error));
  if (job.note) bits.push(h("p", {}, job.note));
  if (job.outputUrl?.startsWith("https://")) {
    bits.push(h("a", { href: job.outputUrl, target: "_blank", rel: "noopener noreferrer" }, "Open output"));
  }
  if (job.runUuid) bits.push(h("p", {}, `Run ${job.runUuid}`));
  const actions = h("div", { class: "row-actions" });
  const refresh = h("button", { class: "text-button", type: "button" }, "Reconcile");
  refresh.addEventListener("click", () => {
    void (async () => {
      const result = await reconcileJob(job.id);
      const main = document.querySelector("#main");
      if (!(main instanceof HTMLElement)) return;
      if (!result.ok) {
        const note = document.querySelector("#notice");
        note?.append(chip("red", "Failed"), h("span", {}, result.failure?.detail ?? "Reconcile failed."));
      } else if (main.dataset.paint === "overview") await paintOverview(main);
      else if (desk) {
        const agent = desk.agents.find((item) => item.slug === main.dataset.paint);
        if (agent) await paintAgent(main, agent);
      }
    })();
  });
  actions.append(refresh);
  if (job.status !== "completed") {
    const manual = h("button", { class: "text-button", type: "button" }, "Mark unknown");
    manual.addEventListener("click", () => {
      void (async () => {
        const result = await reconcileJob(job.id, { action: "set", status: "unknown", note: "Marked unknown by the owner." });
        const main = document.querySelector("#main");
        if (!(main instanceof HTMLElement)) return;
        if (!result.ok) return;
        if (main.dataset.paint === "overview") await paintOverview(main);
        else if (desk) {
          const agent = desk.agents.find((item) => item.slug === main.dataset.paint);
          if (agent) await paintAgent(main, agent);
        }
      })();
    });
    actions.append(manual);
  }
  bits.push(actions);
  const body = h("div", { class: "need-body" });
  for (const bit of bits) body.append(bit);
  return body;
}
function questItems(data) {
  const slackFolders = data.setup.slackFolders.postr && data.setup.slackFolders.ready && data.setup.slackFolders.posted;
  const items = [
    { label: "Sign-in", ready: true, detail: data.auth === "access" ? "Cloudflare Access is checking this browser." : "Local sign-in is on. Production uses Access." },
    { label: "Encryption", ready: data.setup.encryption, detail: "TOKEN_ENCRYPTION_KEY encrypts Google tokens on the server." },
    { label: "Google", ready: data.setup.google === "connected", detail: data.setup.googleEmail ? `Connected as ${data.setup.googleEmail}.` : "Connect Google from Drive. This desk cannot reuse a Grok Bot connection." },
    { label: "Sheet read", ready: data.setup.scopes.sheetsReadonly, detail: "spreadsheets.readonly reads the Automate Jobs tab." },
    { label: "Folder browse", ready: data.setup.scopes.driveReadonly || data.setup.scopes.drive, detail: "drive.readonly lists existing folders. drive.file plus Picker is the narrower upload path." },
    { label: "Callback", ready: data.setup.publicBaseUrl, detail: "PUBLIC_BASE_URL lets an agent report back. The sheet still works without it." },
    { label: "Slack sheet", ready: data.setup.slackSheet, detail: "SLACK_LOG_SHEET_ID is the Postr Log, separate from the brand tracker." },
    { label: "Slack folders", ready: slackFolders, detail: "Postr, Ready to Post, and Posted each need a folder id." }
  ];
  for (const agent of data.agents) {
    const state = data.setup.webhooks[agent.slug] ?? "setup_needed";
    items.push({
      label: `${agent.name} webhook`,
      ready: state === "ready",
      detail: state === "rejected_host" ? "That webhook host is not allowlisted." : "Set the webhook URL and key named in the setup guide."
    });
  }
  return items;
}
function shortRole(agent) {
  const roles = {
    fling: "Brand email",
    cling: "Scripts",
    sling: "Brand posts",
    bling: "Invoices",
    pling: "Analytics",
    slack: "Original posts"
  };
  return roles[agent.slug] ?? agent.role;
}
function xpBar(current, goal, label, tint) {
  const safeGoal = goal > 0 ? goal : 1;
  const wrap = h("div", { class: tint === "player" ? "seg-bar xp" : "seg-bar" });
  if (tint && tint !== "player") wrap.dataset.agent = tint;
  const bar = h("div", {
    class: "segments",
    role: "meter",
    "aria-label": label,
    "aria-valuemin": "0",
    "aria-valuemax": String(safeGoal),
    "aria-valuenow": String(Math.max(0, current))
  });
  for (let index = 0; index < safeGoal; index += 1) {
    const seg = h("span", { class: index < current ? "seg on" : "seg" });
    if (current <= 0 && index === 0) seg.append(h("span", { class: "xp-dot" }));
    bar.append(seg);
  }
  wrap.append(bar);
  return wrap;
}
function statusMark(tone) {
  const mark = h("span", { class: `status-mark tone-${tone}`, "aria-hidden": "true" });
  mark.append(icon(tone));
  return mark;
}
function tick(ready) {
  const mark = h("span", { class: ready ? "tick on" : "tick", "aria-hidden": "true" });
  mark.append(ready ? icon("green") : icon("amber"));
  return mark;
}
function glyph(path) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const shape = document.createElementNS("http://www.w3.org/2000/svg", "path");
  shape.setAttribute("fill", "currentColor");
  shape.setAttribute("d", path);
  svg.append(shape);
  return svg;
}
function chevron() {
  return glyph("M9 6l6 6-6 6v-2.2L13 12 9 8.2z");
}
function lockIcon() {
  return glyph("M7 10V8a5 5 0 0110 0v2h1v10H6V10h1zm2 0h6V8a3 3 0 00-6 0v2z");
}
function arrowIcon() {
  return glyph("M5 12h12l-4-4 1.4-1.4L21 12l-6.6 5.4L13 16l4-4H5z");
}
function taskGlyph(kind) {
  const wrap = h("span", { class: "task-glyph", "aria-hidden": "true" });
  const path = kind === "post" ? "M8 5v14l11-7z" : kind === "draft" ? "M4 20h4l10-10-4-4L4 16v4zm12.5-11.5l1.8-1.8 1.5 1.5-1.8 1.8-1.5-1.5z" : "M4 6h16v2H4V6zm0 5h16v2H4v-2zm0 5h10v2H4v-2z";
  wrap.append(glyph(path));
  return wrap;
}
function playerBadge() {
  const badge = h("span", { class: "player-badge", "aria-hidden": "true" });
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("fill", "currentColor");
  path.setAttribute("d", "M12 2l2.4 5.6L20 8.2l-4 3.8.9 5.8L12 15.8 7.1 17.8 8 12 4 8.2l5.6-.6z");
  svg.append(path);
  badge.append(svg);
  return badge;
}
function infoToggle(label, text) {
  const node = document.createElement("details");
  node.className = "info-pop";
  const summary = document.createElement("summary");
  summary.setAttribute("aria-label", `About ${label}`);
  summary.append(infoIcon());
  const copy = document.createElement("p");
  copy.textContent = text;
  node.append(summary, copy);
  return node;
}
function infoIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("fill", "currentColor");
  path.setAttribute("d", "M12 2a10 10 0 100 20 10 10 0 000-20zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z");
  svg.append(path);
  return svg;
}
function chip(tone, label) {
  const node = h("span", { class: `chip tone-${tone}` });
  node.append(icon(tone), document.createTextNode(label));
  return node;
}
function icon(tone) {
  const paths = {
    red: "M12 2 1 21h22L12 2zm1 14h-2v2h2zm0-8h-2v6h2z",
    amber: "M12 2a10 10 0 100 20 10 10 0 000-20zm1 11H7v-2h4V6h2z",
    blue: "M8 5v14l11-7z",
    green: "M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"
  };
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("ico");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", paths[tone]);
  path.setAttribute("fill", "currentColor");
  svg.append(path);
  return svg;
}
function medallion(slug) {
  const node = h("span", { class: "medallion", "data-agent": slug });
  node.append(avatar(slug));
  return node;
}
function avatar(slug) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 64 64");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("avatar");
  const marks = {
    fling: "M40 16h12v10H40z M42 18h8v6h-8z",
    cling: "M44 14l4 2-16 22-4-2z",
    sling: "M42 18l12 8-12 8z",
    bling: "M46 16a6 6 0 110 12 6 6 0 010-12z",
    pling: "M40 28h4v8h-4z M46 22h4v14h-4z M52 16h4v20h-4z",
    slack: "M48 14l2 6 6 2-6 2-2 6-2-6-6-2 6-2z"
  };
  for (const d of ["M32 14a10 10 0 110 20 10 10 0 010-20z", "M16 54c2-12 10-16 16-16s14 4 16 16", marks[slug] ?? ""]) {
    if (!d) continue;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "currentColor");
    svg.append(path);
  }
  return svg;
}
function fold(summary, ...nodes) {
  const node = document.createElement("details");
  const label = document.createElement("summary");
  label.textContent = summary;
  node.append(label, ...nodes);
  return node;
}
function fillWidth(percent) {
  const step = Math.max(0, Math.min(20, Math.round(percent / 5)));
  return `fill-${step * 5}`;
}
function pop(button) {
  button.classList.remove("pop");
  void button.offsetWidth;
  button.classList.add("pop");
}
function when(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}
function renderDrive(main) {
  if (!desk) return;
  const params = new URLSearchParams(window.location.search);
  const googleFlag = params.get("google");
  main.append(h("p", { class: "kicker" }, "Drive"), h("h1", { class: "title" }, "Photos"));
  if (googleFlag === "connected") main.append(h("p", { class: "statline" }, "Google connected."));
  if (googleFlag === "denied" || googleFlag === "error" || googleFlag === "state") {
    main.append(h("p", { class: "need" }, chip("red", "Failed"), h("span", {}, "Google did not connect.")));
  }
  const googleRow = h("div", { class: "row-actions" });
  if (desk.setup.google === "connected") {
    googleRow.append(chip("green", "Connected"));
    const disconnect = h("button", { class: "text-button", type: "button" }, "Disconnect");
    disconnect.addEventListener("click", () => {
      void disconnectGoogle();
    });
    googleRow.append(disconnect);
  } else if (desk.setup.googleOauth) {
    const connect = h("button", { class: "start", type: "button" }, "Connect Google");
    connect.addEventListener("click", () => {
      pop(connect);
      void connectGoogle();
    });
    googleRow.append(connect);
  } else {
    googleRow.append(chip("amber", "Setup"));
  }
  const browse = fold("Browse note", h("p", {}, "Listing existing folders needs drive.readonly. drive.file can upload after you open a folder with Picker. Uploads are not posts."));
  browse.classList.add("rules");
  googleRow.append(browse);
  if (desk.picker && desk.setup.google === "connected") {
    const pick = h("button", { class: "text-button", type: "button" }, "Open with Picker");
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
    const button = h("button", { class: "drive-choice", type: "button" }, h("span", { class: "start-name" }, folder.label), h("span", { class: "start-kicker" }, folder.configured ? "Choose" : "Setup"));
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
  const input = h("input", { type: "file", accept: "image/jpeg,image/png,image/webp,image/gif", multiple: "true" });
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
async function connectGoogle() {
  const result = await api("/api/automate/google/start", { method: "POST", body: "{}" });
  if (!result.ok || !result.data?.url) {
    alert(result.failure?.detail ?? "Google setup is incomplete.");
    return;
  }
  window.location.href = result.data.url;
}
async function disconnectGoogle() {
  await api("/api/automate/google/disconnect", { method: "POST", body: "{}" });
  window.location.href = "/automate/drive";
}
async function openPicker() {
  if (!desk?.picker) return;
  const token = await api("/api/automate/google/picker-token");
  if (!token.ok || !token.data) {
    window.alert(token.failure?.detail ?? "Picker needs a connected Google account.");
    return;
  }
  await loadPickerScript();
  const gapi = window.gapi;
  const googleApi = window.google;
  if (!gapi || !googleApi) {
    window.alert("Google Picker did not load.");
    return;
  }
  await new Promise((resolve) => gapi.load("picker", resolve));
  const view = new googleApi.picker.DocsView(googleApi.picker.ViewId.FOLDERS);
  view.setSelectFolderEnabled(true);
  view.setMimeTypes("application/vnd.google-apps.folder");
  const picker = new googleApi.picker.PickerBuilder().setAppId(desk.picker.appId).setOAuthToken(token.data.accessToken).setDeveloperKey(desk.picker.apiKey).addView(view).setCallback((data) => {
    if (data.action === googleApi.picker.Action.PICKED && data.docs?.[0]?.id) {
      void acceptPickedFolder(data.docs[0].id);
    }
  }).build();
  picker.setVisible(true);
}
async function acceptPickedFolder(folderId) {
  const result = await api("/api/automate/drive/open", {
    method: "POST",
    body: JSON.stringify({ folderId })
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
function loadPickerScript() {
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
async function showFolder(browser, key, folderId) {
  const query = key ? `key=${encodeURIComponent(key)}` : `folderId=${encodeURIComponent(folderId ?? "")}`;
  const result = await api(`/api/automate/drive/list?${query}`);
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
function tile(item, images, browser) {
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
    const img = h("img", { alt: item.name, src: `/api/automate/drive/files/${encodeURIComponent(item.id)}/thumb` });
    const button = h("button", { class: "tile", type: "button" }, img, h("span", {}, item.name));
    button.addEventListener("click", () => openSlideshow(images, item.id));
    return button;
  }
  return h("div", { class: "tile file" }, h("span", { class: "folder-mark" }, "File"), h("span", {}, item.name));
}
function openSlideshow(images, currentId) {
  let index = Math.max(0, images.findIndex((item) => item.id === currentId));
  const dialog = h("dialog", { class: "player" });
  const img = h("img", { alt: "" });
  const caption = h("p", {});
  const prev = h("button", { class: "button button-quiet", type: "button" }, "Previous");
  const next = h("button", { class: "button button-quiet", type: "button" }, "Next");
  const close = h("button", { class: "button", type: "button" }, "Close");
  const show = () => {
    const item = images[index];
    if (!item) return;
    img.src = `/api/automate/drive/files/${encodeURIComponent(item.id)}/preview`;
    img.alt = item.name;
    caption.textContent = `${index + 1} of ${images.length} \xB7 ${item.name}`;
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
function takeFiles(list, queue, hint) {
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
    const row = {
      localId: crypto.randomUUID(),
      name: file.name,
      file,
      progress: 0,
      status: "queued",
      message: "",
      uploadId: null,
      link: null,
      received: 0
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
function renderUploadQueue(queue) {
  queue.replaceChildren();
  for (const row of uploads) {
    const item = h("li", { class: "file-row" }, h("strong", {}, row.name), h("span", {}, statusLine(row)));
    const bar = h("div", { class: "bar" }, h("span", { class: fillWidth(row.progress) }));
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
function statusLine(row) {
  if (row.status === "uploading" || row.status === "queued") return `${Math.round(row.progress)}%`;
  if (row.status === "done") return "Uploaded";
  return row.message || "Failed";
}
async function sendFile(row, queue) {
  row.status = "uploading";
  renderUploadQueue(queue);
  if (!row.uploadId) {
    const started = await api("/api/automate/drive/uploads", {
      method: "POST",
      body: JSON.stringify({
        folderKey: selectedFolderKey,
        folderId: selectedFolderId,
        name: row.file.name,
        mimeType: row.file.type,
        size: row.file.size
      })
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
  const probe = await api(`/api/automate/drive/uploads/${row.uploadId}/retry`, {
    method: "POST",
    body: "{}"
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
async function pump(row, chunkSize, queue) {
  let offset = row.received;
  while (offset < row.file.size) {
    const end = Math.min(offset + chunkSize, row.file.size);
    const chunk = row.file.slice(offset, end);
    const result = await putChunk(row.uploadId ?? "", chunk, offset, end - 1, row.file.size, (loaded) => {
      row.progress = loaded / row.file.size * 100;
      renderUploadQueue(queue);
    });
    if (!result.ok) {
      row.status = "error";
      row.message = result.failure?.detail ?? "Upload failed.";
      renderUploadQueue(queue);
      return;
    }
    const body = result.data;
    offset = body.received ?? end;
    row.received = offset;
    row.progress = offset / row.file.size * 100;
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
function putChunk(uploadId, blob, start, end, total, onProgress) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `/api/automate/drive/uploads/${uploadId}`);
    xhr.setRequestHeader("content-range", `bytes ${start}-${end}/${total}`);
    xhr.setRequestHeader("x-automate-csrf", csrf());
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(start + event.loaded);
    };
    xhr.onload = () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        data = null;
      }
      const record = data;
      resolve({
        ok: xhr.status >= 200 && xhr.status < 300,
        data,
        failure: xhr.status >= 200 && xhr.status < 300 ? null : { detail: record?.detail ?? record?.error ?? "Upload failed." }
      });
    };
    xhr.onerror = () => resolve({ ok: false, data: null, failure: { detail: "The upload request failed before a response." } });
    xhr.send(blob);
  });
}
boot().catch(() => renderFatal("The desk could not load."));
