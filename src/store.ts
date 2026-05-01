import Database from "better-sqlite3";
import { mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SwarmEvent } from "./schema.js";

/** Parse JSON safely, returning `fallback` on malformed input. */
function safeJsonParse<T>(json: string, fallback: T): T {
  try { return JSON.parse(json) as T; } catch { return fallback; }
}

export interface ClaimRow {
  run_id: string;
  path: string;
  kind: "file" | "symbol";
  task_id: string;
  claimed_at: string;
}

export interface RunRow {
  id: string;
  goal: string;
  status: string;
  created_at: string;
  updated_at: string;
}

/**
 * Local persistence: SQLite cho structured state + JSONL append cho replay.
 * MVP scope: runs, tasks, claims, events. Không có transcripts/artifacts table chưa.
 */
export class SwarmStore {
  private db: Database.Database;
  private jsonlPath: string;

  constructor(rootDir: string) {
    const dbPath = join(rootDir, ".swarm", "swarm.db");
    this.jsonlPath = join(rootDir, ".swarm", "events.jsonl");
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        goal TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        depends_on TEXT NOT NULL,
        owned_files TEXT NOT NULL,
        owned_symbols TEXT NOT NULL,
        acceptance_checks TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        status TEXT NOT NULL,
        session_id TEXT,
        worktree_path TEXT,
        PRIMARY KEY (run_id, id),
        FOREIGN KEY (run_id) REFERENCES runs(id)
      );
      CREATE TABLE IF NOT EXISTS claims (
        run_id TEXT NOT NULL,
        path TEXT NOT NULL,
        kind TEXT NOT NULL, -- 'file' | 'symbol'
        task_id TEXT NOT NULL,
        claimed_at TEXT NOT NULL,
        PRIMARY KEY (run_id, kind, path)
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(run_id, status);
    `);
    this.ensureColumn("tasks", "session_id", "TEXT");
  }

  private ensureColumn(table: string, column: string, ddl: string): void {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!rows.some((r) => r.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    }
  }

  appendEvent(ev: SwarmEvent): void {
    appendFileSync(this.jsonlPath, JSON.stringify(ev) + "\n", "utf8");
  }

  insertRun(id: string, goal: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO runs (id, goal, status, created_at, updated_at) VALUES (?, ?, 'planning', ?, ?)`,
      )
      .run(id, goal, now, now);
  }

  setRunStatus(id: string, status: string): void {
    this.db
      .prepare(`UPDATE runs SET status = ?, updated_at = ? WHERE id = ?`)
      .run(status, new Date().toISOString(), id);
  }

  getRun(id: string): RunRow | undefined {
    return this.db
      .prepare(`SELECT id, goal, status, created_at, updated_at FROM runs WHERE id = ?`)
      .get(id) as RunRow | undefined;
  }

  listRuns(): RunRow[] {
    return this.db
      .prepare(
        `SELECT id, goal, status, created_at, updated_at
         FROM runs
         ORDER BY updated_at DESC, created_at DESC`,
      )
      .all() as RunRow[];
  }

  insertTask(runId: string, t: {
    id: string;
    summary: string;
    depends_on: string[];
    owned_files: string[];
    owned_symbols: string[];
    acceptance_checks: string[];
    risk_level: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO tasks (id, run_id, summary, depends_on, owned_files, owned_symbols, acceptance_checks, risk_level, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      )
      .run(
        t.id,
        runId,
        t.summary,
        JSON.stringify(t.depends_on),
        JSON.stringify(t.owned_files),
        JSON.stringify(t.owned_symbols),
        JSON.stringify(t.acceptance_checks),
        t.risk_level,
      );
  }

  setTaskStatus(runId: string, taskId: string, status: string, worktreePath?: string): void {
    if (worktreePath !== undefined) {
      this.db
        .prepare(`UPDATE tasks SET status = ?, worktree_path = ? WHERE run_id = ? AND id = ?`)
        .run(status, worktreePath, runId, taskId);
    } else {
      this.db
        .prepare(`UPDATE tasks SET status = ? WHERE run_id = ? AND id = ?`)
        .run(status, runId, taskId);
    }
  }

  listTasks(runId: string): Array<{
    id: string;
    status: string;
    summary: string;
    depends_on: string[];
    owned_files: string[];
    owned_symbols: string[];
    acceptance_checks: string[];
    risk_level: "low" | "medium" | "high";
  }> {
    const rows = this.db
      .prepare(
        `SELECT id, status, summary, depends_on, owned_files, owned_symbols, acceptance_checks, risk_level
         FROM tasks WHERE run_id = ?`,
      )
      .all(runId) as Array<{
        id: string;
        status: string;
        summary: string;
        depends_on: string;
        owned_files: string;
        owned_symbols: string;
        acceptance_checks: string;
        risk_level: string;
      }>;
    return rows.map((r) => ({
      id: r.id,
      status: r.status,
      summary: r.summary,
      depends_on: safeJsonParse(r.depends_on, []),
      owned_files: safeJsonParse(r.owned_files, []),
      owned_symbols: safeJsonParse(r.owned_symbols, []),
      acceptance_checks: safeJsonParse(r.acceptance_checks, []),
      risk_level: r.risk_level as "low" | "medium" | "high",
    }));
  }

  getTaskWorktree(runId: string, taskId: string): string | undefined {
    const row = this.db
      .prepare(`SELECT worktree_path FROM tasks WHERE run_id = ? AND id = ?`)
      .get(runId, taskId) as { worktree_path: string | null } | undefined;
    return row?.worktree_path ?? undefined;
  }

  listTaskWorktrees(runId: string): Array<{ taskId: string; worktreePath: string }> {
    const rows = this.db
      .prepare(`SELECT id, worktree_path FROM tasks WHERE run_id = ? AND worktree_path IS NOT NULL`)
      .all(runId) as Array<{ id: string; worktree_path: string | null }>;
    return rows
      .filter((row): row is { id: string; worktree_path: string } => typeof row.worktree_path === "string")
      .map((row) => ({ taskId: row.id, worktreePath: row.worktree_path }));
  }

  getTaskSessionId(runId: string, taskId: string): string | undefined {
    const row = this.db
      .prepare(`SELECT session_id FROM tasks WHERE run_id = ? AND id = ?`)
      .get(runId, taskId) as { session_id: string | null } | undefined;
    return row?.session_id ?? undefined;
  }

  setTaskSessionId(runId: string, taskId: string, sessionId: string): void {
    this.db
      .prepare(`UPDATE tasks SET session_id = ? WHERE run_id = ? AND id = ?`)
      .run(sessionId, runId, taskId);
  }

  /** Atomic claim: trả về true nếu giành được tất cả paths, false nếu conflict. */
  tryClaim(
    runId: string,
    taskId: string,
    files: string[],
    symbols: string[],
    claimedAt = new Date().toISOString(),
  ): boolean {
    const tx = this.db.transaction(() => {
      const insert = this.db.prepare(
        `INSERT INTO claims (run_id, path, kind, task_id, claimed_at) VALUES (?, ?, ?, ?, ?)`,
      );
      for (const f of files) insert.run(runId, f, "file", taskId, claimedAt);
      for (const s of symbols) insert.run(runId, s, "symbol", taskId, claimedAt);
    });
    try {
      tx();
      return true;
    } catch {
      return false;
    }
  }

  releaseClaims(runId: string, taskId: string): void {
    this.db
      .prepare(`DELETE FROM claims WHERE run_id = ? AND task_id = ?`)
      .run(runId, taskId);
  }

  listClaims(runId: string): ClaimRow[] {
    return this.db
      .prepare(
        `SELECT run_id, path, kind, task_id, claimed_at
         FROM claims
         WHERE run_id = ?
         ORDER BY claimed_at ASC, task_id ASC, kind ASC, path ASC`,
      )
      .all(runId) as ClaimRow[];
  }

  /** Sum all costUsd from events for a run (used for budget enforcement on resume). */
  sumRunCost(runId: string): number {
    let total = 0;
    try {
      const raw = readFileSync(this.jsonlPath, "utf8");
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as { run_id?: string; type?: string; payload?: { costUsd?: number } };
          if (e.run_id === runId && typeof e.payload?.costUsd === "number") total += e.payload.costUsd;
        } catch { /* skip */ }
      }
    } catch { /* file not found — fresh run */ }
    return total;
  }

  releaseStaleClaims(runId: string, olderThanIso: string): ClaimRow[] {
    const tx = this.db.transaction(() => {
      const stale = this.db
        .prepare(
          `SELECT run_id, path, kind, task_id, claimed_at
           FROM claims
           WHERE run_id = ? AND claimed_at < ?
           ORDER BY claimed_at ASC, task_id ASC, kind ASC, path ASC`,
        )
        .all(runId, olderThanIso) as ClaimRow[];
      if (stale.length > 0) {
        this.db
          .prepare(`DELETE FROM claims WHERE run_id = ? AND claimed_at < ?`)
          .run(runId, olderThanIso);
      }
      return stale;
    });
    return tx();
  }

  close(): void {
    this.db.close();
  }
}
