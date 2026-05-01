import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { initProject } from "./init.js";
import { loadConfig } from "./config.js";
import { runDoctor } from "./doctor.js";
import { SwarmStore } from "./store.js";
import { ClaudeRunner } from "./runner.js";
import { Planner } from "./planner.js";
import { executeRun } from "./run-control.js";
import { loadReplay } from "./replay.js";
import { SwarmConfigSchema, type SwarmConfig } from "./schema.js";

export interface UiServerOptions {
  host?: string;
  port?: number;
  open?: boolean;
}

interface JsonError {
  error: string;
}

export async function startUiServer(rootDir: string, opts: UiServerOptions = {}): Promise<string> {
  const cwd = resolve(rootDir);
  const host = opts.host ?? "127.0.0.1";
  const requestedPort = opts.port ?? 8787;
  const server = createServer((req, res) => {
    void handleRequest(cwd, req, res);
  });

  const port = await listen(server, host, requestedPort);
  const url = `http://${host}:${port}`;
  if (opts.open !== false) void openBrowser(url);
  return url;
}

async function handleRequest(rootDir: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://localhost");

    if (method === "OPTIONS") {
      send(res, 204, "", "text/plain");
      return;
    }

    if (method === "GET" && url.pathname === "/") {
      send(res, 200, HTML, "text/html; charset=utf-8");
      return;
    }

    if (method === "GET" && url.pathname === "/favicon.ico") {
      send(res, 204, "", "image/x-icon");
      return;
    }

    if (method === "GET" && url.pathname === "/api/overview") {
      json(res, await overview(rootDir));
      return;
    }

    // POST actions — must be checked before GET /api/runs/:id
    const runAction = /^\/api\/runs\/([^/]+)\/(run|resume)$/.exec(url.pathname);
    if (method === "POST" && runAction) {
      const runId = decodeURIComponent(runAction[1] ?? "");
      const resumed = runAction[2] === "resume";
      json(res, await executeRun(rootDir, runId, { resumed }));
      return;
    }

    if (method === "GET" && url.pathname.startsWith("/api/runs/")) {
      const runId = decodeURIComponent(url.pathname.slice("/api/runs/".length));
      json(res, runDetail(rootDir, runId));
      return;
    }

    if (method === "POST" && url.pathname === "/api/init") {
      json(res, await initProject(rootDir));
      return;
    }

    if (method === "POST" && url.pathname === "/api/config") {
      const body = await readJson<{ goal?: string; parallelism?: number; budget_usd?: number }>(req);
      const cfg = await loadOrDefaultConfig(rootDir);
      const next = SwarmConfigSchema.parse({
        ...cfg,
        goal: body.goal ?? cfg.goal,
        parallelism: body.parallelism ?? cfg.parallelism,
        budget_usd: body.budget_usd ?? cfg.budget_usd,
      });
      await writeFile(join(rootDir, "swarm.yaml"), stringifyYaml(next), "utf8");
      json(res, { ok: true, config: next });
      return;
    }

    if (method === "POST" && url.pathname === "/api/plan") {
      const body = await readJson<{ goal?: string }>(req);
      json(res, await planRun(rootDir, body.goal));
      return;
    }

    json(res, { error: "Not found" }, 404);
  } catch (err) {
    json(res, { error: err instanceof Error ? err.message : String(err) }, 500);
  }
}

async function overview(rootDir: string): Promise<unknown> {
  const [config, doctor] = await Promise.all([readConfigSafe(rootDir), runDoctor(rootDir)]);
  const store = new SwarmStore(rootDir);
  try {
    const runs = store.listRuns().map((run) => {
      const tasks = store.listTasks(run.id);
      const counts = countStatuses(tasks.map((task) => task.status));
      return { ...run, task_count: tasks.length, counts };
    });
    return {
      rootDir,
      hasConfig: existsSync(join(rootDir, "swarm.yaml")),
      config,
      doctor,
      runs,
    };
  } finally {
    store.close();
  }
}

function runDetail(rootDir: string, runId: string): unknown {
  const store = new SwarmStore(rootDir);
  try {
    const run = store.getRun(runId);
    if (!run) return { error: `No run found: ${runId}` } satisfies JsonError;
    const tasks = store.listTasks(runId);
    const replay = loadReplay(rootDir, runId);
    return {
      run,
      tasks,
      claims: store.listClaims(runId),
      replay: {
        event_count: replay.events.length,
        cost_usd: replay.costUsd,
        malformed_lines: replay.malformedLines,
        events: replay.events.slice(-80),
      },
    };
  } finally {
    store.close();
  }
}

async function planRun(rootDir: string, goal?: string): Promise<unknown> {
  const cfg = await loadConfig(rootDir);
  const nextCfg = goal ? { ...cfg, goal } : cfg;
  const runId = randomUUID();
  const store = new SwarmStore(rootDir);
  try {
    store.insertRun(runId, nextCfg.goal);
    const planner = new Planner(new ClaudeRunner(), nextCfg);
    const { plan, costUsd, attempts, fallbackUsed, fallbackReason } = await planner.plan(rootDir);
    store.appendEvent({
      run_id: runId,
      type: "PlanCreated",
      ts: new Date().toISOString(),
      payload: { goal: nextCfg.goal, taskCount: plan.tasks.length, costUsd, attempts, fallbackUsed },
    });
    if (fallbackUsed) {
      store.appendEvent({
        run_id: runId,
        type: "PlanFallbackUsed",
        ts: new Date().toISOString(),
        payload: { reason: fallbackReason ?? "planner output was not usable", attempts },
      });
    }
    for (const task of plan.tasks) store.insertTask(runId, task);
    store.setRunStatus(runId, "ready");
    return { runId, taskCount: plan.tasks.length, costUsd, fallbackUsed };
  } catch (err) {
    store.setRunStatus(runId, "failed");
    throw err;
  } finally {
    store.close();
  }
}

async function readConfigSafe(rootDir: string): Promise<SwarmConfig | null> {
  try {
    return await loadConfig(rootDir);
  } catch {
    return null;
  }
}

async function loadOrDefaultConfig(rootDir: string): Promise<SwarmConfig> {
  const current = await readConfigSafe(rootDir);
  if (current) return current;
  return SwarmConfigSchema.parse({
    version: "0.1",
    goal: "Describe your goal here",
    parallelism: 2,
    budget_usd: 5,
  });
}

function countStatuses(statuses: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const status of statuses) out[status] = (out[status] ?? 0) + 1;
  return out;
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  req.setEncoding("utf8");
  let raw = "";
  for await (const chunk of req) raw += String(chunk);
  raw = raw.trim();
  return (raw ? JSON.parse(raw) : {}) as T;
}

function json(res: ServerResponse, value: unknown, status = 200): void {
  send(res, status, JSON.stringify(value), "application/json; charset=utf-8");
}

function send(res: ServerResponse, status: number, body: string, contentType: string): void {
  res.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "Content-Type",
  });
  res.end(body);
}

function listen(server: ReturnType<typeof createServer>, host: string, port: number): Promise<number> {
  return new Promise((resolveListen, reject) => {
    const tryPort = (candidate: number) => {
      server.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && candidate < port + 20) {
          tryPort(candidate + 1);
          return;
        }
        reject(err);
      });
      server.listen(candidate, host, () => resolveListen(candidate));
    };
    tryPort(port);
  });
}

async function openBrowser(url: string): Promise<void> {
  const { execa } = await import("execa");
  const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  await execa(command, args, { reject: false, windowsHide: true });
}

const HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>swarm-cp</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f5ef;
      --panel: #fffdfa;
      --ink: #171717;
      --muted: #6d6a62;
      --line: #ded8ca;
      --accent: #177a5b;
      --accent-ink: #ffffff;
      --warn: #a65f00;
      --fail: #b42318;
      --ok: #177a5b;
      --soft: #ece7db;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
    }
    button, input, textarea { font: inherit; }
    button {
      border: 1px solid var(--ink);
      background: var(--ink);
      color: white;
      height: 36px;
      padding: 0 14px;
      border-radius: 6px;
      cursor: pointer;
    }
    button.secondary { background: transparent; color: var(--ink); border-color: var(--line); }
    button:disabled { opacity: .55; cursor: wait; }
    .shell { min-height: 100svh; display: grid; grid-template-columns: 300px 1fr; }
    aside { border-right: 1px solid var(--line); padding: 22px; background: #fbfaf6; }
    main { padding: 26px clamp(20px, 4vw, 54px); }
    .brand { display: flex; align-items: baseline; justify-content: space-between; gap: 14px; margin-bottom: 26px; }
    h1 { font-size: 26px; margin: 0; line-height: 1; }
    h2 { font-size: 18px; margin: 0 0 14px; }
    h3 { font-size: 13px; margin: 20px 0 8px; color: var(--muted); text-transform: uppercase; }
    .muted { color: var(--muted); }
    .path { word-break: break-all; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
    .stack { display: grid; gap: 12px; }
    .row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .workspace { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(320px, .65fr); gap: 22px; align-items: start; }
    .surface { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 18px; }
    textarea, input {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fff;
      color: var(--ink);
      padding: 10px 11px;
      outline: none;
    }
    textarea { min-height: 124px; resize: vertical; }
    label { display: grid; gap: 6px; color: var(--muted); font-size: 12px; }
    label span { color: var(--muted); }
    .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .checks, .runs, .tasks, .events { display: grid; gap: 8px; }
    .item {
      border: 1px solid var(--line);
      border-radius: 7px;
      padding: 10px 11px;
      background: #fff;
      transition: border-color .15s ease, transform .15s ease, background .15s ease;
    }
    .item:hover { border-color: #b8ae9b; transform: translateY(-1px); }
    .run { cursor: pointer; }
    .run.active { border-color: var(--accent); background: #f3fbf6; }
    .pill {
      display: inline-flex;
      align-items: center;
      min-height: 22px;
      border-radius: 999px;
      padding: 0 8px;
      background: var(--soft);
      color: var(--ink);
      font-size: 12px;
      white-space: nowrap;
    }
    .ok { color: var(--ok); }
    .warn { color: var(--warn); }
    .fail { color: var(--fail); }
    .meter { height: 8px; border-radius: 999px; background: var(--soft); overflow: hidden; margin-top: 8px; display: flex; }
    .bar-done { background: var(--ok); }
    .bar-failed, .bar-needs_arbitration { background: var(--fail); }
    .bar-running { background: #2f6fed; }
    .bar-pending { background: #b9b1a3; }
    .task-head { display: flex; justify-content: space-between; gap: 10px; align-items: start; }
    code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    pre { white-space: pre-wrap; margin: 0; font-size: 12px; color: #34312c; }
    .toast { min-height: 20px; color: var(--muted); }
    @media (max-width: 920px) {
      .shell { grid-template-columns: 1fr; }
      aside { border-right: 0; border-bottom: 1px solid var(--line); }
      .workspace { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <aside>
      <div class="brand">
        <h1>swarm-cp</h1>
        <span class="pill" id="statusPill">loading</span>
      </div>
      <div class="stack">
        <div>
          <div class="muted">Workspace</div>
          <div class="path" id="rootDir"></div>
        </div>
        <button id="refreshBtn" class="secondary">Refresh</button>
        <button id="initBtn" class="secondary">Initialize project</button>
      </div>
      <h3>Runs</h3>
      <div class="runs" id="runs"></div>
    </aside>
    <main>
      <div class="workspace">
        <section class="stack">
          <div class="surface">
            <h2>Goal</h2>
            <div class="stack">
              <label><span>What the swarm should complete</span><textarea id="goal"></textarea></label>
              <div class="form-grid">
                <label><span>Parallelism</span><input id="parallelism" type="number" min="1" max="16"></label>
                <label><span>Budget USD</span><input id="budget" type="number" min="1" step="1"></label>
              </div>
              <div class="row">
                <button id="saveBtn" class="secondary">Save config</button>
                <button id="planBtn">Plan run</button>
                <span class="toast" id="toast"></span>
              </div>
            </div>
          </div>
          <div class="surface">
            <div class="row" style="justify-content: space-between;">
              <h2 id="runTitle">Run detail</h2>
              <div class="row">
                <button id="runBtn" class="secondary" disabled>Run</button>
                <button id="resumeBtn" class="secondary" disabled>Resume</button>
              </div>
            </div>
            <div id="runDetail" class="stack muted">Select a run to inspect task progress and replay events.</div>
          </div>
        </section>
        <section class="stack">
          <div class="surface">
            <h2>Doctor</h2>
            <div class="checks" id="checks"></div>
          </div>
          <div class="surface">
            <h2>Replay</h2>
            <div class="events" id="events"></div>
          </div>
        </section>
      </div>
    </main>
  </div>
  <script>
    const state = { overview: null, selectedRunId: null, busy: false };
    const $ = (id) => document.getElementById(id);
    const api = async (path, opts = {}) => {
      const res = await fetch(path, {
        ...opts,
        headers: { 'content-type': 'application/json', ...(opts.headers || {}) }
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || res.statusText);
      return data;
    };
    const setBusy = (busy, msg = '') => {
      state.busy = busy;
      ['refreshBtn','initBtn','saveBtn','planBtn','runBtn','resumeBtn'].forEach(id => $(id).disabled = busy || (['runBtn','resumeBtn'].includes(id) && !state.selectedRunId));
      $('toast').textContent = msg;
    };
    const refresh = async () => {
      state.overview = await api('/api/overview');
      renderOverview();
      if (state.selectedRunId) await loadRun(state.selectedRunId, false);
    };
    const renderOverview = () => {
      const o = state.overview;
      $('rootDir').textContent = o.rootDir;
      $('statusPill').textContent = o.hasConfig ? 'configured' : 'needs init';
      $('goal').value = o.config?.goal || '';
      $('parallelism').value = o.config?.parallelism || 2;
      $('budget').value = o.config?.budget_usd || 5;
      $('checks').innerHTML = o.doctor.map(c => '<div class="item"><div class="row"><strong class="' + c.level + '">' + c.level.toUpperCase() + '</strong><span>' + esc(c.name) + '</span></div><div class="muted">' + esc(c.message) + '</div></div>').join('');
      $('runs').innerHTML = o.runs.length ? o.runs.map(runCard).join('') : '<div class="muted">No runs yet.</div>';
      document.querySelectorAll('[data-run]').forEach(el => el.addEventListener('click', () => loadRun(el.dataset.run)));
    };
    const runCard = (r) => {
      const done = r.counts.done || 0, failed = (r.counts.failed || 0) + (r.counts.needs_arbitration || 0), running = r.counts.running || 0, pending = r.counts.pending || 0;
      const total = Math.max(r.task_count, 1);
      return '<div class="item run ' + (r.id === state.selectedRunId ? 'active' : '') + '" data-run="' + escAttr(r.id) + '">' +
        '<div class="row" style="justify-content: space-between;"><strong>' + esc(shortId(r.id)) + '</strong><span class="pill">' + esc(r.status) + '</span></div>' +
        '<div class="muted">' + esc(trim(r.goal, 86)) + '</div>' +
        '<div class="meter"><span class="bar-done" style="width:' + pct(done,total) + '%"></span><span class="bar-failed" style="width:' + pct(failed,total) + '%"></span><span class="bar-running" style="width:' + pct(running,total) + '%"></span><span class="bar-pending" style="width:' + pct(pending,total) + '%"></span></div>' +
      '</div>';
    };
    const loadRun = async (runId, mark = true) => {
      const detail = await api('/api/runs/' + encodeURIComponent(runId));
      if (mark) state.selectedRunId = runId;
      $('runBtn').disabled = state.busy || !runId;
      $('resumeBtn').disabled = state.busy || !runId;
      $('runTitle').textContent = 'Run ' + shortId(runId);
      $('runDetail').innerHTML = '<div class="tasks">' + detail.tasks.map(taskCard).join('') + '</div>';
      $('events').innerHTML = detail.replay.events.length ? detail.replay.events.slice().reverse().map(eventCard).join('') : '<div class="muted">No replay events yet.</div>';
      renderOverview();
    };
    const taskCard = (t) => '<div class="item"><div class="task-head"><strong>' + esc(t.id) + '</strong><span class="pill">' + esc(t.status) + '</span></div><div>' + esc(t.summary) + '</div><div class="muted">' + esc(t.owned_files.join(', ') || 'No owned files') + '</div></div>';
    const eventCard = (e) => '<div class="item"><div class="row"><strong>' + esc(e.type) + '</strong>' + (e.task_id ? '<span class="pill">' + esc(e.task_id) + '</span>' : '') + '</div><pre>' + esc(JSON.stringify(e.payload, null, 2)) + '</pre></div>';
    const post = async (path, body, message) => {
      try {
        setBusy(true, message);
        const data = await api(path, { method: 'POST', body: JSON.stringify(body || {}) });
        if (data.runId) state.selectedRunId = data.runId;
        await refresh();
        $('toast').textContent = 'Done';
      } catch (err) {
        $('toast').textContent = err.message;
      } finally {
        setBusy(false);
      }
    };
    $('refreshBtn').onclick = () => refresh();
    $('initBtn').onclick = () => post('/api/init', {}, 'Initializing...');
    $('saveBtn').onclick = () => post('/api/config', { goal: $('goal').value, parallelism: Number($('parallelism').value), budget_usd: Number($('budget').value) }, 'Saving...');
    $('planBtn').onclick = () => post('/api/plan', { goal: $('goal').value }, 'Planning with Claude...');
    $('runBtn').onclick = () => post('/api/runs/' + encodeURIComponent(state.selectedRunId) + '/run', {}, 'Running workers...');
    $('resumeBtn').onclick = () => post('/api/runs/' + encodeURIComponent(state.selectedRunId) + '/resume', {}, 'Resuming...');
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
    const escAttr = esc;
    const shortId = (s) => String(s).slice(0, 8);
    const trim = (s, n) => String(s || '').length > n ? String(s).slice(0, n - 1) + '...' : String(s || '');
    const pct = (n, total) => Math.round((n / total) * 100);
    refresh().catch(err => $('toast').textContent = err.message);
  </script>
</body>
</html>`;
