import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { extname, join, normalize } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const env = loadDevVars(join(root, ".dev.vars"));
const dataDir = join(root, ".data");
mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(join(dataDir, "automate.sqlite"));
const ready = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'jobs'").get();
if (!ready) db.exec(readFileSync(join(root, "migrations/0001_init.sql"), "utf8"));

const publicDir = join(root, "public");
const worker = await import(pathToFileURL(join(root, "dist/worker.js")).href);
const port = Number(process.env.PORT || 8787);

const server = createServer(async (req, res) => {
  const host = req.headers.host || `127.0.0.1:${port}`;
  const url = `http://${host}${req.url}`;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value == null) continue;
    headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  const request = new Request(url, {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
  });
  const response = await worker.default.fetch(request, {
    ...env,
    DB: sqliteD1(db),
    ASSETS: assets(),
  });
  const out = Buffer.from(await response.arrayBuffer());
  const responseHeaders = {};
  response.headers.forEach((value, key) => {
    if (key === "set-cookie") return;
    responseHeaders[key] = value;
  });
  const cookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  res.writeHead(response.status, { ...responseHeaders, "set-cookie": cookies });
  res.end(out);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`desk listening on http://127.0.0.1:${port}`);
});

function assets() {
  return {
    async fetch(request) {
      const url = new URL(request.url);
      const rel = url.pathname === "/" ? "/index.html" : url.pathname;
      const file = normalize(join(publicDir, rel));
      if (!file.startsWith(publicDir) || !existsSync(file)) return new Response("missing", { status: 404 });
      const types = {
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".svg": "image/svg+xml",
        ".txt": "text/plain; charset=utf-8",
      };
      return new Response(readFileSync(file), { headers: { "content-type": types[extname(file)] || "application/octet-stream" } });
    },
  };
}

function sqliteD1(database) {
  return {
    prepare(sql) {
      const bound = (...params) => ({
        bind: (...next) => bound(...next),
        all: async () => ({ results: params.length ? database.prepare(sql).all(...params) : database.prepare(sql).all() }),
        first: async () => (params.length ? database.prepare(sql).get(...params) : database.prepare(sql).get()) ?? null,
        run: async () => {
          const info = params.length ? database.prepare(sql).run(...params) : database.prepare(sql).run();
          return { success: true, meta: { changes: Number(info.changes ?? 0) } };
        },
      });
      return bound();
    },
    async exec(sql) {
      database.exec(sql);
    },
  };
}

function loadDevVars(file) {
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return out;
}
