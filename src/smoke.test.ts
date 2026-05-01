import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "./init.js";
import { loadConfig } from "./config.js";
import { SwarmStore } from "./store.js";
import { PlanSchema, SwarmConfigSchema, EvalSuiteSchema } from "./schema.js";
import { runDoctor, hasFailures, formatChecks } from "./doctor.js";
import { _internals as evalInternals } from "./eval.js";
import { writeFileSync, mkdirSync } from "node:fs";

let tmp: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "swarm-smoke-"));
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("init", () => {
  it("scaffolds expected files", async () => {
    const { created } = await initProject(tmp);
    expect(created).toContain("swarm.yaml");
    expect(created).toContain(".claude/settings.json");
    expect(created).toContain(".claude/agents/swarm-architect.md");
    expect(existsSync(join(tmp, "swarm.yaml"))).toBe(true);
  });

  it("is idempotent", async () => {
    const { created, skipped } = await initProject(tmp);
    expect(created.length).toBe(0);
    expect(skipped.length).toBeGreaterThan(0);
  });
});

describe("config", () => {
  it("loads scaffolded swarm.yaml", async () => {
    const cfg = await loadConfig(tmp);
    expect(cfg.version).toBe("0.1");
    expect(cfg.parallelism).toBe(2);
    expect(cfg.policies.same_file).toBe("block");
  });

  it("rejects bad config", () => {
    expect(() =>
      SwarmConfigSchema.parse({ version: "9.9", goal: "x" }),
    ).toThrow();
  });
});

describe("store + claims", () => {
  it("inserts run, tasks, and enforces atomic file claim", () => {
    const store = new SwarmStore(tmp);
    const runId = "run-1";
    store.insertRun(runId, "test goal");
    store.insertTask(runId, {
      id: "t1",
      summary: "edit a.ts",
      depends_on: [],
      owned_files: ["src/a.ts"],
      owned_symbols: [],
      acceptance_checks: ["echo ok"],
      risk_level: "low",
    });
    store.insertTask(runId, {
      id: "t2",
      summary: "edit a.ts again",
      depends_on: [],
      owned_files: ["src/a.ts"],
      owned_symbols: [],
      acceptance_checks: ["echo ok"],
      risk_level: "low",
    });

    const tasks = store.listTasks(runId);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]?.acceptance_checks).toEqual(["echo ok"]);
    expect(store.listRuns()[0]?.id).toBe(runId);

    expect(store.tryClaim(runId, "t1", ["src/a.ts"], [])).toBe(true);
    // t2 wants the same file → must be blocked
    expect(store.tryClaim(runId, "t2", ["src/a.ts"], [])).toBe(false);
    // After release, t2 can claim
    store.releaseClaims(runId, "t1");
    expect(store.tryClaim(runId, "t2", ["src/a.ts"], [])).toBe(true);

    const oldClaimAt = "2025-01-01T00:00:00.000Z";
    expect(store.tryClaim(runId, "stale", ["src/old.ts"], [], oldClaimAt)).toBe(true);
    const released = store.releaseStaleClaims(runId, "2025-01-01T00:00:01.000Z");
    expect(released).toEqual([
      {
        run_id: runId,
        path: "src/old.ts",
        kind: "file",
        task_id: "stale",
        claimed_at: oldClaimAt,
      },
    ]);
    expect(store.tryClaim(runId, "fresh", ["src/old.ts"], [])).toBe(true);
    store.setTaskSessionId(runId, "t1", "00000000-0000-4000-8000-000000000001");
    expect(store.getTaskSessionId(runId, "t1")).toBe("00000000-0000-4000-8000-000000000001");
    store.setTaskStatus(runId, "t1", "running", "C:/tmp/worktree");
    expect(store.listTaskWorktrees(runId)).toEqual([{ taskId: "t1", worktreePath: "C:/tmp/worktree" }]);

    store.appendEvent({
      run_id: runId,
      type: "PlanCreated",
      ts: new Date().toISOString(),
      payload: { goal: "test goal" },
    });
    const log = readFileSync(join(tmp, ".swarm", "events.jsonl"), "utf8");
    expect(log).toContain("PlanCreated");
    store.close();
  });
});

describe("stream-json parser (verified vs claude 2.1.105)", () => {
  it("extracts final message + cost from result event", async () => {
    const { parseStreamJson } = await import("./runner.js");
    const fixture = [
      '{"type":"system","subtype":"init","session_id":"x"}',
      '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"..."}]}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}',
      '{"type":"result","subtype":"success","result":"hello","total_cost_usd":0.21,"duration_ms":14861}',
    ].join("\n");
    const r = parseStreamJson(fixture);
    expect(r.finalMessage).toBe("hello");
    expect(r.costUsd).toBe(0.21);
    expect(r.sessionId).toBe("x");
  });

  it("falls back to last assistant text when no result event", async () => {
    const { parseStreamJson } = await import("./runner.js");
    const fixture = [
      '{"type":"system","subtype":"init"}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"first"}]}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"second"}]}}',
    ].join("\n");
    const r = parseStreamJson(fixture);
    expect(r.finalMessage).toBe("second");
    expect(r.costUsd).toBeUndefined();
  });

  it("ignores non-JSON garbage lines", async () => {
    const { parseStreamJson } = await import("./runner.js");
    const r = parseStreamJson('garbage\n{"type":"result","result":"ok","total_cost_usd":0.01}\n');
    expect(r.finalMessage).toBe("ok");
    expect(r.costUsd).toBe(0.01);
  });

  it("extracts cost from non-JSON Claude log text", async () => {
    const { extractCostFromText } = await import("./runner.js");
    expect(extractCostFromText("done\ntotal_cost_usd: 0.094\n")).toBeCloseTo(0.094, 4);
    expect(extractCostFromText("\u001b[32m'total_cost_usd'=1.25\u001b[0m")).toBeCloseTo(1.25, 4);
  });

  it("classifies Claude 429 overload as transient", async () => {
    const { isTransientClaudeError } = await import("./runner.js");
    expect(
      isTransientClaudeError({
        stdout: "",
        stderr: "API Error: Request rejected (429) · The service may be temporarily overloaded",
      }),
    ).toBe(true);
    expect(isTransientClaudeError({ stdout: "", stderr: "syntax error" })).toBe(false);
  });

  it("classifies Windows libuv Claude crash as transient", async () => {
    const { isTransientClaudeError } = await import("./runner.js");
    expect(
      isTransientClaudeError({
        stdout: "",
        stderr: "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\\win\\async.c, line 76",
      }),
    ).toBe(true);
  });
});

describe("worktree branch naming", () => {
  it("produces deterministic branch name", async () => {
    const { WorktreeService } = await import("./worktree.js");
    const w = new WorktreeService(tmp);
    expect(w.branchName("R", "T")).toBe("swarm/R/T");
  });
});

describe("gate (acceptance_checks runner)", () => {
  it("passes when all checks exit 0", async () => {
    const { runAcceptanceChecks } = await import("./gate.js");
    const v = await runAcceptanceChecks(tmp, ['node -e "process.exit(0)"', 'node -e "1+1"']);
    expect(v.passed).toBe(true);
    expect(v.results).toHaveLength(2);
    expect(v.results.every((r) => r.outcome === "passed")).toBe(true);
  });

  it("fails when any check has a real non-zero exit", async () => {
    const { runAcceptanceChecks } = await import("./gate.js");
    const v = await runAcceptanceChecks(tmp, ['node -e "process.exit(0)"', 'node -e "process.exit(2)"']);
    expect(v.passed).toBe(false);
    expect(v.results[1]?.outcome).toBe("failed");
    expect(v.results[1]?.exitCode).toBe(2);
  });

  it("treats empty checklist as not-passed", async () => {
    const { runAcceptanceChecks } = await import("./gate.js");
    const v = await runAcceptanceChecks(tmp, []);
    expect(v.passed).toBe(false);
  });

  it("treats 'tool not found' as skipped, not failed", async () => {
    const { runAcceptanceChecks } = await import("./gate.js");
    // Use a definitely-nonexistent binary; both Windows and POSIX surface it
    // either as exit 127/255/9009 or with a recognized stderr pattern.
    const v = await runAcceptanceChecks(tmp, [
      'node -e "process.exit(0)"',
      "definitely-not-a-real-binary-zzz999 --foo",
    ]);
    expect(v.results[1]?.outcome).toBe("skipped");
    // Gate still passes because 1 real-passed + 1 skipped is acceptable.
    expect(v.passed).toBe(true);
  });

  it("does not pass when ALL checks are skipped", async () => {
    const { runAcceptanceChecks } = await import("./gate.js");
    const v = await runAcceptanceChecks(tmp, ["definitely-not-a-real-binary-zzz999"]);
    expect(v.passed).toBe(false);
    expect(v.results[0]?.outcome).toBe("skipped");
  });
});

describe("scope boundary", () => {
  it("passes when changed files stay inside owned_files", async () => {
    const { checkOwnedFileScope } = await import("./scope.js");
    const r = checkOwnedFileScope(
      ["src/a.ts", "src/components/Button.tsx", "docs/guide.md"],
      ["src/a.ts", "src/components/", "docs/*.md"],
    );
    expect(r.passed).toBe(true);
    expect(r.outOfScopeFiles).toEqual([]);
  });

  it("flags package.json edits outside task ownership", async () => {
    const { checkOwnedFileScope } = await import("./scope.js");
    const r = checkOwnedFileScope(["src/a.ts", "package.json"], ["src/a.ts"]);
    expect(r.passed).toBe(false);
    expect(r.outOfScopeFiles).toEqual(["package.json"]);
  });

  it("normalizes Windows-style changed paths", async () => {
    const { checkOwnedFileScope } = await import("./scope.js");
    const r = checkOwnedFileScope(["src\\a.ts"], ["src/a.ts"]);
    expect(r.passed).toBe(true);
  });

  it("treats globstar slash as zero or more directories", async () => {
    const { checkOwnedFileScope } = await import("./scope.js");
    const r = checkOwnedFileScope(
      ["tests/arrays.test.js", "tests/unit/strings.test.js"],
      ["tests/**/*.test.js"],
    );
    expect(r.passed).toBe(true);
  });
});

describe("worktree changed files", () => {
  it("reports modified files before commit", async () => {
    const { execa } = await import("execa");
    const { WorktreeService } = await import("./worktree.js");
    const dir = mkdtempSync(join(tmpdir(), "swarm-wt-status-"));
    writeFileSync(join(dir, "a.txt"), "one\n");
    await execa("git", ["init"], { cwd: dir });
    await execa("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    await execa("git", ["config", "user.name", "Test"], { cwd: dir });
    await execa("git", ["add", "a.txt"], { cwd: dir });
    await execa("git", ["commit", "-m", "init"], { cwd: dir });

    const worktrees = new WorktreeService(dir);
    const wt = await worktrees.create("run", "task");
    writeFileSync(join(wt, "a.txt"), "two\n");
    writeFileSync(join(wt, "package.json"), "{}\n");

    expect(await worktrees.changedFiles(wt)).toEqual(["a.txt", "package.json"]);
    await worktrees.remove(wt);
    await worktrees.deleteBranch("run", "task", true);
    rmSync(dir, { recursive: true, force: true });
  }, 20_000);
});

describe("dispatcher scope enforcement", () => {
  it("marks tasks needs_arbitration when worker edits outside owned_files", async () => {
    const { execa } = await import("execa");
    const { Dispatcher } = await import("./dispatcher.js");
    const { WorktreeService } = await import("./worktree.js");
    const dir = mkdtempSync(join(tmpdir(), "swarm-dispatch-scope-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
    await execa("git", ["init"], { cwd: dir });
    await execa("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    await execa("git", ["config", "user.name", "Test"], { cwd: dir });
    await execa("git", ["add", "src/a.ts"], { cwd: dir });
    await execa("git", ["commit", "-m", "init"], { cwd: dir });

    const store = new SwarmStore(dir);
    const runId = "run-scope";
    store.insertRun(runId, "scope test");
    store.insertTask(runId, {
      id: "t1",
      summary: "edit src/a.ts",
      depends_on: [],
      owned_files: ["src/a.ts"],
      owned_symbols: [],
      acceptance_checks: [],
      risk_level: "low",
    });

    const runner = {
      run: async (opts: { cwd: string }) => {
        writeFileSync(join(opts.cwd, "package.json"), "{}\n");
        return { exitCode: 0, stdout: "", stderr: "", finalMessage: "done", costUsd: 0.12 };
      },
    };
    const cfg = SwarmConfigSchema.parse({ version: "0.1", goal: "scope test" });
    const dispatcher = new Dispatcher({
      runner: runner as never,
      worktrees: new WorktreeService(dir),
      store,
      cfg,
      rootDir: dir,
    });

    const summary = await dispatcher.run(runId);
    expect(summary).toEqual({ done: 0, failed: 1, blocked: 0, budgetExceeded: false });
    expect(store.listTasks(runId)[0]?.status).toBe("needs_arbitration");
    const log = readFileSync(join(dir, ".swarm", "events.jsonl"), "utf8");
    expect(log).toContain("ArbitrationRequested");
    expect(log).toContain("package.json");
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }, 20_000);
});

describe("dispatcher stale-lock detection", () => {
  it("releases stale claims, requests arbitration, and lets pending work proceed", async () => {
    const { execa } = await import("execa");
    const { Dispatcher } = await import("./dispatcher.js");
    const { WorktreeService } = await import("./worktree.js");
    const dir = mkdtempSync(join(tmpdir(), "swarm-dispatch-stale-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
    await execa("git", ["init"], { cwd: dir });
    await execa("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    await execa("git", ["config", "user.name", "Test"], { cwd: dir });
    await execa("git", ["add", "src/a.ts"], { cwd: dir });
    await execa("git", ["commit", "-m", "init"], { cwd: dir });

    const store = new SwarmStore(dir);
    const runId = "run-stale";
    store.insertRun(runId, "stale claim test");
    store.insertTask(runId, {
      id: "stale-task",
      summary: "crashed owner",
      depends_on: [],
      owned_files: ["src/a.ts"],
      owned_symbols: [],
      acceptance_checks: [],
      risk_level: "low",
    });
    store.insertTask(runId, {
      id: "next-task",
      summary: "continue work",
      depends_on: [],
      owned_files: ["src/a.ts"],
      owned_symbols: [],
      acceptance_checks: [],
      risk_level: "low",
    });
    store.setTaskStatus(runId, "stale-task", "running");
    expect(store.tryClaim(runId, "stale-task", ["src/a.ts"], [], "2025-01-01T00:00:00.000Z")).toBe(
      true,
    );

    const runner = {
      run: async (opts: { cwd: string }) => {
        writeFileSync(join(opts.cwd, "src", "a.ts"), "export const a = 2;\n");
        return { exitCode: 0, stdout: "", stderr: "", finalMessage: "done", costUsd: 0.03 };
      },
    };
    const cfg = SwarmConfigSchema.parse({ version: "0.1", goal: "stale claim test" });
    const dispatcher = new Dispatcher({
      runner: runner as never,
      worktrees: new WorktreeService(dir),
      store,
      cfg,
      rootDir: dir,
    });

    const summary = await dispatcher.run(runId);
    expect(summary).toEqual({ done: 1, failed: 1, blocked: 0, budgetExceeded: false });
    const statuses = Object.fromEntries(store.listTasks(runId).map((t) => [t.id, t.status]));
    expect(statuses["stale-task"]).toBe("needs_arbitration");
    expect(statuses["next-task"]).toBe("done");
    const log = readFileSync(join(dir, ".swarm", "events.jsonl"), "utf8");
    expect(log).toContain("stale_lock_released");
    expect(log).toContain("TaskValidated");
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }, 20_000);
});

describe("worker model routing", () => {
  it("routes only low-risk workers through the configured fast model alias", async () => {
    const { resolveClaudeModelAlias, workerModelForTask } = await import("./dispatcher.js");
    const cfg = SwarmConfigSchema.parse({ version: "0.1", goal: "model routing" });
    const low = {
      id: "low",
      summary: "low",
      depends_on: [],
      owned_files: [],
      owned_symbols: [],
      acceptance_checks: [],
      risk_level: "low" as const,
    };
    const medium = { ...low, id: "medium", risk_level: "medium" as const };
    expect(resolveClaudeModelAlias("fast")).toBe("sonnet");
    expect(resolveClaudeModelAlias("strong")).toBe("opus");
    expect(resolveClaudeModelAlias("claude-custom")).toBe("claude-custom");
    expect(workerModelForTask(low, cfg)).toBe("sonnet");
    expect(workerModelForTask(medium, cfg)).toBeUndefined();
  });
});

describe("resume recovery", () => {
  it("moves running tasks without claims back to pending", async () => {
    const dir = mkdtempSync(join(tmpdir(), "swarm-resume-recover-"));
    const store = new SwarmStore(dir);
    const runId = "run-resume";
    store.insertRun(runId, "resume test");
    store.insertTask(runId, {
      id: "done-task",
      summary: "already done",
      depends_on: [],
      owned_files: ["src/done.ts"],
      owned_symbols: [],
      acceptance_checks: [],
      risk_level: "low",
    });
    store.insertTask(runId, {
      id: "running-task",
      summary: "lost worker",
      depends_on: [],
      owned_files: ["src/a.ts"],
      owned_symbols: [],
      acceptance_checks: [],
      risk_level: "low",
    });
    store.setTaskStatus(runId, "done-task", "done");
    store.setTaskStatus(runId, "running-task", "running");

    expect(store.getRun(runId)?.status).toBe("planning");
    const { recoverRunningTasksForResume } = await import("./run-control.js");
    expect(recoverRunningTasksForResume(store, runId)).toBe(1);
    const statuses = Object.fromEntries(store.listTasks(runId).map((t) => [t.id, t.status]));
    expect(statuses["done-task"]).toBe("done");
    expect(statuses["running-task"]).toBe("pending");
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("resumes pending recovered work and does not rerun completed tasks", async () => {
    const { execa } = await import("execa");
    const { executeRun } = await import("./run-control.js");
    const dir = mkdtempSync(join(tmpdir(), "swarm-resume-run-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
    await execa("git", ["init"], { cwd: dir });
    await execa("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    await execa("git", ["config", "user.name", "Test"], { cwd: dir });
    await execa("git", ["add", "src/a.ts"], { cwd: dir });
    await execa("git", ["commit", "-m", "init"], { cwd: dir });
    await initProject(dir);

    const store = new SwarmStore(dir);
    const runId = "run-resume-real";
    store.insertRun(runId, "resume real");
    store.insertTask(runId, {
      id: "done-task",
      summary: "already done",
      depends_on: [],
      owned_files: ["src/done.ts"],
      owned_symbols: [],
      acceptance_checks: [],
      risk_level: "low",
    });
    store.insertTask(runId, {
      id: "running-task",
      summary: "finish a",
      depends_on: [],
      owned_files: ["src/a.ts"],
      owned_symbols: [],
      acceptance_checks: [],
      risk_level: "low",
    });
    store.setTaskStatus(runId, "done-task", "done");
    store.setTaskStatus(runId, "running-task", "running");
    store.close();

    let calls = 0;
    const sessionIds: string[] = [];
    const models: Array<string | undefined> = [];
    const runner = {
      run: async (opts: { cwd: string; sessionId?: string; model?: string }) => {
        calls++;
        if (opts.sessionId) sessionIds.push(opts.sessionId);
        models.push(opts.model);
        writeFileSync(join(opts.cwd, "src", "a.ts"), "export const a = 2;\n");
        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
          finalMessage: "done",
          costUsd: 0.04,
          sessionId: opts.sessionId,
        };
      },
    };

    const result = await executeRun(dir, runId, { resumed: true, runner: runner as never });
    expect(result.recoveredRunning).toBe(1);
    expect(result.summary).toEqual({ done: 2, failed: 0, blocked: 0, budgetExceeded: false });
    expect(calls).toBe(1);
    expect(sessionIds).toHaveLength(1);
    expect(models).toEqual(["sonnet"]);

    const verifyStore = new SwarmStore(dir);
    const statuses = Object.fromEntries(verifyStore.listTasks(runId).map((t) => [t.id, t.status]));
    expect(statuses["done-task"]).toBe("done");
    expect(statuses["running-task"]).toBe("done");
    expect(verifyStore.getTaskSessionId(runId, "running-task")).toBe(sessionIds[0]);
    const log = readFileSync(join(dir, ".swarm", "events.jsonl"), "utf8");
    expect(log).toContain('"resumed":true');
    verifyStore.close();
    rmSync(dir, { recursive: true, force: true });
  }, 20_000);

  it("leaves running tasks with stale claims for arbitration during resume", async () => {
    const { execa } = await import("execa");
    const { executeRun } = await import("./run-control.js");
    const dir = mkdtempSync(join(tmpdir(), "swarm-resume-stale-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
    await execa("git", ["init"], { cwd: dir });
    await execa("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    await execa("git", ["config", "user.name", "Test"], { cwd: dir });
    await execa("git", ["add", "src/a.ts"], { cwd: dir });
    await execa("git", ["commit", "-m", "init"], { cwd: dir });
    await initProject(dir);

    const store = new SwarmStore(dir);
    const runId = "run-resume-stale";
    store.insertRun(runId, "resume stale");
    store.insertTask(runId, {
      id: "stale-task",
      summary: "stale worker",
      depends_on: [],
      owned_files: ["src/a.ts"],
      owned_symbols: [],
      acceptance_checks: [],
      risk_level: "low",
    });
    store.setTaskStatus(runId, "stale-task", "running");
    expect(store.tryClaim(runId, "stale-task", ["src/a.ts"], [], "2025-01-01T00:00:00.000Z")).toBe(
      true,
    );
    store.close();

    const runner = {
      run: async () => {
        throw new Error("stale task should not rerun");
      },
    };
    const result = await executeRun(dir, runId, { resumed: true, runner: runner as never });
    expect(result.recoveredRunning).toBe(0);
    expect(result.summary).toEqual({ done: 0, failed: 1, blocked: 0, budgetExceeded: false });

    const verifyStore = new SwarmStore(dir);
    expect(verifyStore.listTasks(runId)[0]?.status).toBe("needs_arbitration");
    const log = readFileSync(join(dir, ".swarm", "events.jsonl"), "utf8");
    expect(log).toContain("stale_lock_released");
    expect(log).toContain('"resumed":true');
    verifyStore.close();
    rmSync(dir, { recursive: true, force: true });
  }, 20_000);
});

describe("planner prompt (platform-aware)", () => {
  it("warns about Windows tooling on win32", async () => {
    const { buildPlannerPrompt } = await import("./planner.js");
    const cfg = {
      version: "0.1" as const,
      goal: "g",
      parallelism: 2,
      budget_usd: 5,
      planner: "swarm-architect",
      worker: "swarm-implementer",
      quality_gate: "swarm-quality-gate",
      policies: {
        same_file: "block" as const,
        same_symbol: "ask" as const,
        out_of_scope_edit: "fail" as const,
        tests_required: true,
        security_scan_required: false,
      },
      routing: { plan_model: "strong", worker_model: "fast", gate_model: "strong" },
      runtime: { worker_timeout_ms: 30 * 60_000, stale_claim_ms: 30 * 60_000 },
    };
    const p = buildPlannerPrompt(cfg, "win32");
    expect(p).toContain("Windows");
    expect(p).toContain("AVOID");
    expect(p).toContain("grep");
    expect(p).toContain("node -e");
  });

  it("uses POSIX guidance on linux", async () => {
    const { buildPlannerPrompt } = await import("./planner.js");
    const cfg = {
      version: "0.1" as const,
      goal: "g",
      parallelism: 2,
      budget_usd: 5,
      planner: "swarm-architect",
      worker: "swarm-implementer",
      quality_gate: "swarm-quality-gate",
      policies: {
        same_file: "block" as const,
        same_symbol: "ask" as const,
        out_of_scope_edit: "fail" as const,
        tests_required: true,
        security_scan_required: false,
      },
      routing: { plan_model: "strong", worker_model: "fast", gate_model: "strong" },
      runtime: { worker_timeout_ms: 30 * 60_000, stale_claim_ms: 30 * 60_000 },
    };
    const p = buildPlannerPrompt(cfg, "linux");
    expect(p).toContain("POSIX tools");
    expect(p).not.toContain("PowerShell");
  });
});

describe("dispatcher runtime config", () => {
  it("passes configured worker timeout to Claude runner", async () => {
    const { execa } = await import("execa");
    const { Dispatcher } = await import("./dispatcher.js");
    const { WorktreeService } = await import("./worktree.js");
    const dir = mkdtempSync(join(tmpdir(), "swarm-dispatch-timeout-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
    await execa("git", ["init"], { cwd: dir });
    await execa("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    await execa("git", ["config", "user.name", "Test"], { cwd: dir });
    await execa("git", ["add", "src/a.ts"], { cwd: dir });
    await execa("git", ["commit", "-m", "init"], { cwd: dir });

    const store = new SwarmStore(dir);
    const runId = "run-timeout";
    store.insertRun(runId, "timeout test");
    store.insertTask(runId, {
      id: "t1",
      summary: "edit a.ts",
      depends_on: [],
      owned_files: ["src/a.ts"],
      owned_symbols: [],
      acceptance_checks: [],
      risk_level: "low",
    });

    const runner = {
      run: async (opts: { cwd: string; timeoutMs?: number }) => {
        expect(opts.timeoutMs).toBe(12345);
        writeFileSync(join(opts.cwd, "src", "a.ts"), "export const a = 2;\n");
        return { exitCode: 0, stdout: "", stderr: "", finalMessage: "done", costUsd: 0.01 };
      },
    };
    const cfg = SwarmConfigSchema.parse({
      version: "0.1",
      goal: "timeout test",
      runtime: { worker_timeout_ms: 12345, stale_claim_ms: 67890 },
    });
    const dispatcher = new Dispatcher({
      runner: runner as never,
      worktrees: new WorktreeService(dir),
      store,
      cfg,
      rootDir: dir,
    });

    expect(await dispatcher.run(runId)).toEqual({ done: 1, failed: 0, blocked: 0, budgetExceeded: false });
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }, 20_000);
});

describe("planner JSON extraction", () => {
  it("extracts fenced JSON", async () => {
    const { extractPlannerJson } = await import("./planner.js");
    expect(extractPlannerJson('```json\n{"goal":"g","tasks":[]}\n```')).toBe('{"goal":"g","tasks":[]}');
  });

  it("accepts raw JSON object output", async () => {
    const { extractPlannerJson } = await import("./planner.js");
    expect(extractPlannerJson('{"goal":"g","tasks":[]}')).toBe('{"goal":"g","tasks":[]}');
  });

  it("extracts JSON embedded in prose", async () => {
    const { extractPlannerJson } = await import("./planner.js");
    expect(extractPlannerJson('Here is the plan:\n{"goal":"g","tasks":[]}\nDone.')).toBe('{"goal":"g","tasks":[]}');
  });

  it("handles braces inside JSON strings", async () => {
    const { extractPlannerJson } = await import("./planner.js");
    expect(extractPlannerJson('Plan: {"goal":"write {x}","tasks":[]}')).toBe('{"goal":"write {x}","tasks":[]}');
  });
});

describe("planner fallback", () => {
  it("recovers JSON from stdout when final result text is not JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "swarm-planner-stdout-json-"));
    const { Planner } = await import("./planner.js");
    const cfg = SwarmConfigSchema.parse({ version: "0.1", goal: "ship production" });
    const json = JSON.stringify({
      goal: "ship production",
      tasks: [
        {
          id: "T1",
          summary: "Do it",
          depends_on: [],
          owned_files: ["src/a.js"],
          owned_symbols: [],
          acceptance_checks: ["git diff --check"],
          risk_level: "low",
        },
      ],
    });
    const runner = {
      run: async () => ({
        exitCode: 0,
        stdout: `{"type":"assistant","message":{"content":[{"type":"text","text":${JSON.stringify(`\`\`\`json\n${json}\n\`\`\``)}}]}}\n`,
        stderr: "",
        finalMessage: "Done",
        costUsd: 0.01,
      }),
    };
    const result = await new Planner(runner as never, cfg).plan(dir);
    expect(result.fallbackUsed).toBe(false);
    expect(result.plan.tasks[0]?.id).toBe("T1");
    rmSync(dir, { recursive: true, force: true });
  });

  it("infers per-file fallback tasks from source filenames in the goal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "swarm-planner-file-fallback-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "strings.js"), "export const s = 1;\n");
    writeFileSync(join(dir, "src", "arrays.js"), "export const a = 1;\n");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
    const { buildFallbackPlan, inferOwnedFilesFromGoal } = await import("./planner.js");
    const goal = "Improve strings.js and arrays.js. Add tests in tests/<moduleName>.test.js.";
    expect(inferOwnedFilesFromGoal(dir, goal)).toEqual(["src/arrays.js", "src/strings.js"]);
    const plan = buildFallbackPlan(dir, goal);
    expect(plan.tasks).toHaveLength(2);
    expect(plan.tasks[0]?.owned_files).toContain("tests/arrays.test.js");
    expect(plan.tasks[1]?.owned_files).toContain("tests/strings.test.js");
    expect(plan.tasks.some((task) => task.owned_files.includes("**/*"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates a conservative one-task plan when model output is not parseable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "swarm-planner-fallback-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
    const { Planner } = await import("./planner.js");
    const cfg = SwarmConfigSchema.parse({ version: "0.1", goal: "ship production" });
    const runner = {
      run: async () => ({
        exitCode: 0,
        stdout: '{"type":"result","result":"not json","total_cost_usd":0.01}',
        stderr: "",
        finalMessage: "I cannot produce JSON",
        costUsd: 0.01,
      }),
    };
    const result = await new Planner(runner as never, cfg).plan(dir);
    expect(result.fallbackUsed).toBe(true);
    expect(result.attempts).toBe(2);
    expect(result.costUsd).toBeCloseTo(0.02, 4);
    expect(result.plan.tasks).toHaveLength(1);
    expect(result.plan.tasks[0]?.owned_files).toEqual(["**/*"]);
    expect(result.plan.tasks[0]?.acceptance_checks).toContain("npm test");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("plan schema", () => {
  it("accepts a valid plan", () => {
    const ok = PlanSchema.safeParse({
      goal: "g",
      tasks: [
        {
          id: "x",
          summary: "s",
          depends_on: [],
          owned_files: [],
          owned_symbols: [],
          acceptance_checks: [],
          risk_level: "low",
        },
      ],
    });
    expect(ok.success).toBe(true);
  });

  it("rejects empty tasks", () => {
    const r = PlanSchema.safeParse({ goal: "g", tasks: [] });
    expect(r.success).toBe(false);
  });
});

describe("eval suite schema", () => {
  it("accepts a minimal suite", () => {
    const r = EvalSuiteSchema.safeParse({
      version: "0.1",
      entries: [{ id: "x", fixture: "./f", goal: "g" }],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.entries[0]?.modes).toEqual(["baseline", "swarm"]);
      expect(r.data.entries[0]?.runs).toBe(1);
    }
  });

  it("rejects suite with no entries", () => {
    const r = EvalSuiteSchema.safeParse({ version: "0.1", entries: [] });
    expect(r.success).toBe(false);
  });
});

describe("eval cost extraction", () => {
  it("extracts total_cost_usd from the last result event", () => {
    const stream = [
      '{"type":"assistant","message":{}}',
      '{"type":"result","total_cost_usd":0.1234,"num_turns":3}',
      '{"type":"result","total_cost_usd":0.5678,"num_turns":7}',
    ].join("\n");
    expect(evalInternals.extractCostFromStream(stream)).toBeCloseTo(0.5678, 4);
  });

  it("returns 0 when no result event is present", () => {
    expect(evalInternals.extractCostFromStream('{"type":"assistant"}\n')).toBe(0);
  });

  it("ignores malformed lines", () => {
    const stream = ["not json", '{"type":"result","total_cost_usd":0.99}'].join("\n");
    expect(evalInternals.extractCostFromStream(stream)).toBeCloseTo(0.99, 4);
  });

  it("extracts process cost from stderr when stdout has no cost", () => {
    expect(evalInternals.extractCostFromProcess("no cost", "total_cost_usd: 0.42")).toBeCloseTo(0.42, 4);
  });

  it("extracts planner cost from CLI output before falling back to stream metadata", () => {
    expect(evalInternals.extractPlanCost("Plan saved (planner cost: $0.33).", "")).toBeCloseTo(0.33, 4);
    expect(evalInternals.extractPlanCost("", "total_cost_usd: 0.44")).toBeCloseTo(0.44, 4);
  });

  it("sums worker cost from event log", async () => {
    const dir = mkdtempSync(join(tmpdir(), "swarm-eval-"));
    const path = join(dir, "events.jsonl");
    writeFileSync(
      path,
      [
        '{"run_id":"r","task_id":"t1","type":"TaskValidated","ts":"2025-01-01T00:00:00Z","payload":{"costUsd":0.1}}',
        '{"run_id":"r","task_id":"t2","type":"TaskFailed","ts":"2025-01-01T00:00:00Z","payload":{"costUsd":0.2}}',
        '{"run_id":"r","type":"PlanCreated","ts":"2025-01-01T00:00:00Z","payload":{"costUsd":99}}',
      ].join("\n"),
    );
    const total = await evalInternals.sumWorkerCost(path);
    // Plan cost is excluded; only Task* events count.
    expect(total).toBeCloseTo(0.3, 4);
    rmSync(dir, { recursive: true, force: true });
  });

  it("CSV-escapes commas, quotes, newlines", () => {
    expect(evalInternals.csvEscape("plain")).toBe("plain");
    expect(evalInternals.csvEscape('a, "b"')).toBe('"a, ""b"""');
    expect(evalInternals.csvEscape(123)).toBe("123");
  });

  it("normalizes relative node script command specs against the caller cwd", () => {
    const spec = evalInternals.parseCommandSpec("node dist/cli.js", "C:/repo");
    expect(spec.command).toBe("node");
    expect(spec.args[0]?.replace(/\\/g, "/")).toBe("C:/repo/dist/cli.js");
  });

  it("does not treat a passing verify command as success when the mode failed", () => {
    expect(
      evalInternals.modeSucceeded({
        entryId: "x",
        mode: "baseline",
        runIndex: 0,
        wallMs: 1,
        costUsd: 0,
        verifyExit: 0,
        workdir: "w",
        extras: { exitCode: 1 },
      }),
    ).toBe(false);
    expect(
      evalInternals.modeSucceeded({
        entryId: "x",
        mode: "swarm",
        runIndex: 0,
        wallMs: 1,
        costUsd: 0,
        verifyExit: 0,
        workdir: "w",
        extras: { planExitCode: 1, runOk: false },
      }),
    ).toBe(false);
  });

  it("supports a bounded eval timeout override for smoke runs", () => {
    const old = process.env.SWARM_EVAL_TIMEOUT_MS;
    const oldRetries = process.env.SWARM_EVAL_MAX_RETRIES;
    process.env.SWARM_EVAL_TIMEOUT_MS = "12345";
    process.env.SWARM_EVAL_MAX_RETRIES = "0";
    expect(evalInternals.evalTimeoutMs()).toBe(12345);
    expect(evalInternals.evalMaxRetries()).toBe(0);
    if (old === undefined) delete process.env.SWARM_EVAL_TIMEOUT_MS;
    else process.env.SWARM_EVAL_TIMEOUT_MS = old;
    if (oldRetries === undefined) delete process.env.SWARM_EVAL_MAX_RETRIES;
    else process.env.SWARM_EVAL_MAX_RETRIES = oldRetries;
  });
});

describe("replay", () => {
  it("renders chronological timeline and total cost for a run", async () => {
    const { loadReplay, formatReplay } = await import("./replay.js");
    const dir = mkdtempSync(join(tmpdir(), "swarm-replay-"));
    mkdirSync(join(dir, ".swarm"), { recursive: true });
    writeFileSync(
      join(dir, ".swarm", "events.jsonl"),
      [
        '{"run_id":"r1","task_id":"t1","type":"TaskValidated","ts":"2025-01-01T00:00:02.000Z","payload":{"costUsd":0.2}}',
        '{"run_id":"other","type":"PlanCreated","ts":"2025-01-01T00:00:00.000Z","payload":{"costUsd":9}}',
        '{"run_id":"r1","type":"PlanCreated","ts":"2025-01-01T00:00:01.000Z","payload":{"costUsd":0.1,"taskCount":1,"goal":"demo"}}',
        "not json",
      ].join("\n"),
    );

    const summary = loadReplay(dir, "r1");
    expect(summary.events.map((e) => e.type)).toEqual(["PlanCreated", "TaskValidated"]);
    expect(summary.costUsd).toBeCloseTo(0.3, 4);
    expect(summary.malformedLines).toBe(1);

    const out = formatReplay(summary);
    expect(out).toContain("Replay r1");
    expect(out).toContain("Cost: $0.3000");
    expect(out).toContain("PlanCreated");
    expect(out).toContain("TaskValidated t1 cost=$0.2000");
    rmSync(dir, { recursive: true, force: true });
  });

  it("renders RunCompleted with totalCostUsd and budget info", async () => {
    const { loadReplay, formatReplay } = await import("./replay.js");
    const dir = mkdtempSync(join(tmpdir(), "swarm-replay-complete-"));
    mkdirSync(join(dir, ".swarm"), { recursive: true });
    writeFileSync(
      join(dir, ".swarm", "events.jsonl"),
      [
        '{"run_id":"r1","type":"PlanCreated","ts":"2025-01-01T00:00:01.000Z","payload":{"costUsd":0.1}}',
        '{"run_id":"r1","task_id":"t1","type":"TaskValidated","ts":"2025-01-01T00:00:02.000Z","payload":{"costUsd":0.3}}',
        '{"run_id":"r1","type":"RunCompleted","ts":"2025-01-01T00:00:03.000Z","payload":{"done":1,"failed":0,"blocked":0,"totalCostUsd":0.4,"budgetExceeded":false}}',
      ].join("\n"),
    );
    const summary = loadReplay(dir, "r1");
    const out = formatReplay(summary);
    expect(out).toContain("RunCompleted");
    expect(out).toContain("total_cost=$0.4000");
    expect(out).toContain("done=1");
    rmSync(dir, { recursive: true, force: true });
  });

  it("renders RunCompleted with budget exceeded warning", async () => {
    const { loadReplay, formatReplay } = await import("./replay.js");
    const dir = mkdtempSync(join(tmpdir(), "swarm-replay-budget-"));
    mkdirSync(join(dir, ".swarm"), { recursive: true });
    writeFileSync(
      join(dir, ".swarm", "events.jsonl"),
      [
        '{"run_id":"r1","type":"RunCompleted","ts":"2025-01-01T00:00:03.000Z","payload":{"done":1,"failed":0,"blocked":2,"totalCostUsd":5.2,"budgetExceeded":true}}',
      ].join("\n"),
    );
    const out = formatReplay(loadReplay(dir, "r1"));
    expect(out).toContain("BUDGET_EXCEEDED");
    expect(out).toContain("blocked=2");
    expect(out).toContain("total_cost=$5.2000");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("doctor", () => {
  it("returns ok-or-warn when run on a fresh inited dir with git", async () => {
    const dir = mkdtempSync(join(tmpdir(), "swarm-doctor-"));
    // Make it look like a git repo (just needs the directory present).
    mkdirSync(join(dir, ".git"));
    await initProject(dir);
    const checks = await runDoctor(dir);
    // Must include core checks
    const names = checks.map((c) => c.name);
    expect(names).toContain("node");
    expect(names).toContain("git-repo");
    expect(names).toContain("swarm.yaml");
    expect(names).toContain(".claude/agents");
    // Output is non-empty and renders without throwing
    expect(formatChecks(checks).length).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("flags missing git repo as fail", async () => {
    const dir = mkdtempSync(join(tmpdir(), "swarm-doctor-nogit-"));
    const checks = await runDoctor(dir);
    const gitRepo = checks.find((c) => c.name === "git-repo");
    expect(gitRepo?.level).toBe("fail");
    expect(hasFailures(checks)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ============================================================
// Phase 3 tests
// ============================================================

describe("Phase 3.1: hook event parsing from stream-json", () => {
  it("parses hook events from --include-hook-events stream", async () => {
    const { parseStreamJson } = await import("./runner.js");
    const fixture = [
      '{"type":"system","subtype":"init","session_id":"s1"}',
      '{"type":"hook","hook_type":"PreToolUse","tool_name":"Edit","ts":"2025-06-01T00:00:01.000Z"}',
      '{"type":"hook","hook_type":"PostToolUse","tool_name":"Edit","ts":"2025-06-01T00:00:02.000Z","duration_ms":340}',
      '{"type":"lifecycle","subtype":"SubagentStart","subagent_name":"implementer","ts":"2025-06-01T00:00:03.000Z"}',
      '{"type":"lifecycle","subtype":"SubagentStop","subagent_name":"implementer","ts":"2025-06-01T00:00:04.000Z"}',
      '{"type":"hook","hook_type":"Stop","ts":"2025-06-01T00:00:05.000Z","exit_code":0}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"done"}]}}',
      '{"type":"result","subtype":"success","result":"done","total_cost_usd":0.15}',
    ].join("\n");
    const r = parseStreamJson(fixture);
    expect(r.finalMessage).toBe("done");
    expect(r.costUsd).toBe(0.15);
    expect(r.sessionId).toBe("s1");
    expect(r.hookEvents).toHaveLength(5);
    expect(r.hookEvents[0]?.hookType).toBe("PreToolUse");
    expect(r.hookEvents[0]?.toolName).toBe("Edit");
    expect(r.hookEvents[1]?.hookType).toBe("PostToolUse");
    expect(r.hookEvents[2]?.hookType).toBe("SubagentStart");
    expect(r.hookEvents[2]?.subagentName).toBe("implementer");
    expect(r.hookEvents[3]?.hookType).toBe("SubagentStop");
    expect(r.hookEvents[4]?.hookType).toBe("Stop");
    expect(r.hookEvents[4]?.payload.exit_code).toBe(0);
  });

  it("returns empty hookEvents when stream has no hook lines", async () => {
    const { parseStreamJson } = await import("./runner.js");
    const fixture = [
      '{"type":"system","subtype":"init","session_id":"s2"}',
      '{"type":"result","result":"ok","total_cost_usd":0.01}',
    ].join("\n");
    const r = parseStreamJson(fixture);
    expect(r.hookEvents).toHaveLength(0);
  });

  it("handles unknown hook_type fields gracefully", async () => {
    const { parseStreamJson } = await import("./runner.js");
    const fixture = '{"type":"hook","hook_type":"FutureNewHook","ts":"2025-06-01T00:00:01.000Z","data":"x"}\n';
    const r = parseStreamJson(fixture);
    expect(r.hookEvents).toHaveLength(1);
    expect(r.hookEvents[0]?.hookType).toBe("FutureNewHook");
  });
});

describe("Phase 3.2: hook event normalizer", () => {
  it("normalizes known hook types into SwarmEvent types", async () => {
    const { normalizeHookEvents } = await import("./hooks.js");
    const hooks = [
      { hookType: "PreToolUse", ts: "2025-06-01T00:00:01.000Z", toolName: "Edit", payload: {} },
      { hookType: "PostToolUse", ts: "2025-06-01T00:00:02.000Z", toolName: "Edit", payload: { duration_ms: 120 } },
      { hookType: "SubagentStart", ts: "2025-06-01T00:00:03.000Z", subagentName: "impl", payload: {} },
      { hookType: "SubagentStop", ts: "2025-06-01T00:00:04.000Z", subagentName: "impl", payload: {} },
      { hookType: "TaskCreated", ts: "2025-06-01T00:00:05.000Z", payload: {} },
      { hookType: "TeammateIdle", ts: "2025-06-01T00:00:06.000Z", payload: { message: "idle" } },
      { hookType: "Stop", ts: "2025-06-01T00:00:07.000Z", payload: { exit_code: 0 } },
    ];
    const events = normalizeHookEvents(hooks, { runId: "r1", taskId: "t1" });
    expect(events).toHaveLength(7);
    expect(events[0]?.type).toBe("HookPreToolUse");
    expect(events[0]?.payload.toolName).toBe("Edit");
    expect(events[1]?.type).toBe("HookPostToolUse");
    expect(events[1]?.payload.durationMs).toBe(120);
    expect(events[2]?.type).toBe("HookSubagentStart");
    expect(events[3]?.type).toBe("HookSubagentStop");
    expect(events[4]?.type).toBe("HookSubagentStart"); // TaskCreated → SubagentStart
    expect(events[5]?.type).toBe("HookNotification"); // TeammateIdle → Notification
    expect(events[6]?.type).toBe("HookStop");
    expect(events[6]?.payload.exitCode).toBe(0);
    // All events have correct run_id/task_id
    for (const ev of events) {
      expect(ev.run_id).toBe("r1");
      expect(ev.task_id).toBe("t1");
    }
  });

  it("drops unknown hook types by default", async () => {
    const { normalizeHookEvents } = await import("./hooks.js");
    const hooks = [
      { hookType: "UnknownFutureHook", ts: "2025-06-01T00:00:01.000Z", payload: {} },
    ];
    const events = normalizeHookEvents(hooks, { runId: "r1", taskId: "t1" });
    expect(events).toHaveLength(0);
  });

  it("keeps unknown hook types as Notification when dropUnknown is false", async () => {
    const { normalizeHookEvents } = await import("./hooks.js");
    const hooks = [
      { hookType: "UnknownFutureHook", ts: "2025-06-01T00:00:01.000Z", payload: {} },
    ];
    const events = normalizeHookEvents(hooks, { runId: "r1", taskId: "t1", dropUnknown: false });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("HookNotification");
  });

  it("summarizes tool usage counts", async () => {
    const { normalizeHookEvents, summarizeToolUse } = await import("./hooks.js");
    const hooks = [
      { hookType: "PreToolUse", ts: "t1", toolName: "Edit", payload: {} },
      { hookType: "PreToolUse", ts: "t2", toolName: "Read", payload: {} },
      { hookType: "PreToolUse", ts: "t3", toolName: "Edit", payload: {} },
      { hookType: "PostToolUse", ts: "t4", toolName: "Edit", payload: {} },
    ];
    const events = normalizeHookEvents(hooks, { runId: "r", taskId: "t" });
    const counts = summarizeToolUse(events);
    expect(counts).toEqual({ Edit: 2, Read: 1 });
  });
});

describe("Phase 3.3: doctor worktree parity", () => {
  it("doctor includes git-worktree and claude-hooks checks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "swarm-doctor-phase3-"));
    mkdirSync(join(dir, ".git"));
    await initProject(dir);
    const checks = await runDoctor(dir);
    const names = checks.map((c) => c.name);
    expect(names).toContain("git-worktree");
    expect(names).toContain("claude-hooks");
    // git-worktree should be ok or warn (depending on real .git structure)
    const wt = checks.find((c) => c.name === "git-worktree");
    expect(["ok", "warn"]).toContain(wt?.level);
    rmSync(dir, { recursive: true, force: true });
  }, 20_000);
});

describe("Phase 3.4: pre-merge hooks", () => {
  it("passes when all hook commands exit 0", async () => {
    const { runPreMergeHooks } = await import("./merge-hook.js");
    const r = await runPreMergeHooks(tmp, [
      'node -e "process.exit(0)"',
      'node -e "1+1"',
    ], { runId: "r1", taskId: "t1", branch: "swarm/r1/t1" });
    expect(r.passed).toBe(true);
    expect(r.results).toHaveLength(2);
  });

  it("fails and stops on first non-zero exit", async () => {
    const { runPreMergeHooks } = await import("./merge-hook.js");
    const r = await runPreMergeHooks(tmp, [
      'node -e "process.exit(1)"',
      'node -e "process.exit(0)"',
    ], { runId: "r1", taskId: "t1", branch: "swarm/r1/t1" });
    expect(r.passed).toBe(false);
    expect(r.results).toHaveLength(1); // stops at first failure
    expect(r.results[0]?.exitCode).toBe(1);
  });

  it("passes empty command list", async () => {
    const { runPreMergeHooks } = await import("./merge-hook.js");
    const r = await runPreMergeHooks(tmp, [], { runId: "r1", taskId: "t1", branch: "b" });
    expect(r.passed).toBe(true);
    expect(r.results).toHaveLength(0);
  });

  it("receives SWARM_* env vars", async () => {
    const { runPreMergeHooks } = await import("./merge-hook.js");
    const r = await runPreMergeHooks(tmp, [
      'node -e "if(process.env.SWARM_RUN_ID!==\'r1\')process.exit(1)"',
      'node -e "if(process.env.SWARM_TASK_ID!==\'t1\')process.exit(1)"',
      'node -e "if(process.env.SWARM_BRANCH!==\'swarm/r1/t1\')process.exit(1)"',
    ], { runId: "r1", taskId: "t1", branch: "swarm/r1/t1" });
    expect(r.passed).toBe(true);
  });
});

describe("Phase 3: replay renders hook events", () => {
  it("shows tool and subagent info in timeline", async () => {
    const { loadReplay, formatReplay } = await import("./replay.js");
    const dir = mkdtempSync(join(tmpdir(), "swarm-replay-hooks-"));
    mkdirSync(join(dir, ".swarm"), { recursive: true });
    writeFileSync(
      join(dir, ".swarm", "events.jsonl"),
      [
        '{"run_id":"r1","task_id":"t1","type":"AgentStarted","ts":"2025-06-01T00:00:01.000Z","payload":{}}',
        '{"run_id":"r1","task_id":"t1","type":"HookPreToolUse","ts":"2025-06-01T00:00:02.000Z","payload":{"toolName":"Edit"}}',
        '{"run_id":"r1","task_id":"t1","type":"HookPostToolUse","ts":"2025-06-01T00:00:03.000Z","payload":{"toolName":"Edit"}}',
        '{"run_id":"r1","task_id":"t1","type":"HookSubagentStart","ts":"2025-06-01T00:00:04.000Z","payload":{"subagentName":"impl"}}',
        '{"run_id":"r1","task_id":"t1","type":"HookSubagentStop","ts":"2025-06-01T00:00:05.000Z","payload":{"subagentName":"impl"}}',
        '{"run_id":"r1","task_id":"t1","type":"HookStop","ts":"2025-06-01T00:00:06.000Z","payload":{"exitCode":0}}',
        '{"run_id":"r1","task_id":"t1","type":"HookNotification","ts":"2025-06-01T00:00:07.000Z","payload":{"message":"idle detected"}}',
      ].join("\n"),
    );
    const summary = loadReplay(dir, "r1");
    expect(summary.events).toHaveLength(7);
    const out = formatReplay(summary);
    expect(out).toContain("HookPreToolUse t1");
    expect(out).toContain("tool=Edit");
    expect(out).toContain("HookSubagentStart t1");
    expect(out).toContain("subagent=impl");
    expect(out).toContain("HookStop t1");
    expect(out).toContain("exit=0");
    expect(out).toContain("HookNotification t1");
    expect(out).toContain("idle detected");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("Phase 3: dispatcher persists hook events", () => {
  it("stores normalized hook events from worker run into event log", async () => {
    const { execa } = await import("execa");
    const { Dispatcher } = await import("./dispatcher.js");
    const { WorktreeService } = await import("./worktree.js");
    const dir = mkdtempSync(join(tmpdir(), "swarm-dispatch-hooks-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
    await execa("git", ["init"], { cwd: dir });
    await execa("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    await execa("git", ["config", "user.name", "Test"], { cwd: dir });
    await execa("git", ["add", "src/a.ts"], { cwd: dir });
    await execa("git", ["commit", "-m", "init"], { cwd: dir });

    const store = new SwarmStore(dir);
    const runId = "run-hooks";
    store.insertRun(runId, "hook test");
    store.insertTask(runId, {
      id: "t1",
      summary: "edit a.ts",
      depends_on: [],
      owned_files: ["src/a.ts"],
      owned_symbols: [],
      acceptance_checks: [],
      risk_level: "low",
    });

    const runner = {
      run: async (opts: { cwd: string; includeHookEvents?: boolean }) => {
        expect(opts.includeHookEvents).toBe(true);
        writeFileSync(join(opts.cwd, "src", "a.ts"), "export const a = 2;\n");
        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
          finalMessage: "done",
          costUsd: 0.05,
          hookEvents: [
            { hookType: "PreToolUse", ts: "2025-06-01T00:00:01.000Z", toolName: "Edit", payload: {} },
            { hookType: "PostToolUse", ts: "2025-06-01T00:00:02.000Z", toolName: "Edit", payload: { duration_ms: 50 } },
          ],
        };
      },
    };
    const cfg = SwarmConfigSchema.parse({ version: "0.1", goal: "hook test" });
    const dispatcher = new Dispatcher({
      runner: runner as never,
      worktrees: new WorktreeService(dir),
      store,
      cfg,
      rootDir: dir,
    });

    const summary = await dispatcher.run(runId);
    expect(summary).toEqual({ done: 1, failed: 0, blocked: 0, budgetExceeded: false });
    const log = readFileSync(join(dir, ".swarm", "events.jsonl"), "utf8");
    expect(log).toContain("HookPreToolUse");
    expect(log).toContain("HookPostToolUse");
    expect(log).toContain('"toolName":"Edit"');
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }, 20_000);
});

describe("budget enforcement", () => {
  it("stops dispatching when cumulative cost exceeds budget", async () => {
    const { execa } = await import("execa");
    const { Dispatcher } = await import("./dispatcher.js");
    const { WorktreeService } = await import("./worktree.js");
    const dir = mkdtempSync(join(tmpdir(), "swarm-budget-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(dir, "src", "b.ts"), "export const b = 1;\n");
    await execa("git", ["init"], { cwd: dir });
    await execa("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    await execa("git", ["config", "user.name", "Test"], { cwd: dir });
    await execa("git", ["add", "src/a.ts", "src/b.ts"], { cwd: dir });
    await execa("git", ["commit", "-m", "init"], { cwd: dir });

    const store = new SwarmStore(dir);
    const runId = "run-budget";
    store.insertRun(runId, "budget test");
    store.appendEvent({
      run_id: runId,
      type: "PlanCreated" as const,
      ts: new Date().toISOString(),
      payload: { costUsd: 0.4 },
    });
    store.insertTask(runId, {
      id: "t1",
      summary: "edit a.ts",
      depends_on: [],
      owned_files: ["src/a.ts"],
      owned_symbols: [],
      acceptance_checks: [],
      risk_level: "low",
    });
    store.insertTask(runId, {
      id: "t2",
      summary: "edit b.ts",
      depends_on: ["t1"],
      owned_files: ["src/b.ts"],
      owned_symbols: [],
      acceptance_checks: [],
      risk_level: "low",
    });

    let calls = 0;
    const runner = {
      run: async (opts: { cwd: string }) => {
        calls++;
        const file = calls === 1 ? "a.ts" : "b.ts";
        writeFileSync(join(opts.cwd, "src", file), `export const ${file[0]} = ${calls};\n`);
        return { exitCode: 0, stdout: "", stderr: "", finalMessage: "done", costUsd: 0.35 };
      },
    };
    const cfg = SwarmConfigSchema.parse({ version: "0.1", goal: "budget test", budget_usd: 0.5 });
    const dispatcher = new Dispatcher({
      runner: runner as never,
      worktrees: new WorktreeService(dir),
      store,
      cfg,
      rootDir: dir,
    });

    const summary = await dispatcher.run(runId);
    expect(summary.budgetExceeded).toBe(true);
    expect(calls).toBe(1);
    const tasks = store.listTasks(runId);
    const statuses = Object.fromEntries(tasks.map((t) => [t.id, t.status]));
    expect(statuses["t1"]).toBe("done");
    expect(statuses["t2"]).toBe("pending");
    const log = readFileSync(join(dir, ".swarm", "events.jsonl"), "utf8");
    expect(log).toContain("budget_exceeded");
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }, 20_000);
});

describe("store sumRunCost", () => {
  it("sums costUsd from events for a specific run", () => {
    const dir = mkdtempSync(join(tmpdir(), "swarm-sumcost-"));
    const store = new SwarmStore(dir);
    store.appendEvent({ run_id: "r1", type: "PlanCreated", ts: new Date().toISOString(), payload: { costUsd: 0.1 } });
    store.appendEvent({ run_id: "r1", task_id: "t1", type: "TaskValidated", ts: new Date().toISOString(), payload: { costUsd: 0.2 } });
    store.appendEvent({ run_id: "r2", type: "PlanCreated", ts: new Date().toISOString(), payload: { costUsd: 5 } });
    expect(store.sumRunCost("r1")).toBeCloseTo(0.3, 4);
    expect(store.sumRunCost("r2")).toBeCloseTo(5, 4);
    expect(store.sumRunCost("r3")).toBe(0);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("plan conflict validation", () => {
  it("detects overlapping file ownership when policy is block", async () => {
    const { validatePlanConflicts } = await import("./planner.js");
    const cfg = SwarmConfigSchema.parse({ version: "0.1", goal: "test", policies: { same_file: "block" } });
    const conflicts = validatePlanConflicts({
      goal: "test",
      tasks: [
        { id: "t1", summary: "a", depends_on: [], owned_files: ["src/a.ts"], owned_symbols: [], acceptance_checks: [], risk_level: "low" },
        { id: "t2", summary: "b", depends_on: [], owned_files: ["src/a.ts"], owned_symbols: [], acceptance_checks: [], risk_level: "low" },
      ],
    }, cfg);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.file).toBe("src/a.ts");
    expect(conflicts[0]?.tasks).toEqual(["t1", "t2"]);
  });

  it("returns no conflicts when policy is allow", async () => {
    const { validatePlanConflicts } = await import("./planner.js");
    const cfg = SwarmConfigSchema.parse({ version: "0.1", goal: "test", policies: { same_file: "allow" } });
    const conflicts = validatePlanConflicts({
      goal: "test",
      tasks: [
        { id: "t1", summary: "a", depends_on: [], owned_files: ["src/a.ts"], owned_symbols: [], acceptance_checks: [], risk_level: "low" },
        { id: "t2", summary: "b", depends_on: [], owned_files: ["src/a.ts"], owned_symbols: [], acceptance_checks: [], risk_level: "low" },
      ],
    }, cfg);
    expect(conflicts).toHaveLength(0);
  });

  it("returns no conflicts when tasks own different files", async () => {
    const { validatePlanConflicts } = await import("./planner.js");
    const cfg = SwarmConfigSchema.parse({ version: "0.1", goal: "test" });
    const conflicts = validatePlanConflicts({
      goal: "test",
      tasks: [
        { id: "t1", summary: "a", depends_on: [], owned_files: ["src/a.ts"], owned_symbols: [], acceptance_checks: [], risk_level: "low" },
        { id: "t2", summary: "b", depends_on: [], owned_files: ["src/b.ts"], owned_symbols: [], acceptance_checks: [], risk_level: "low" },
      ],
    }, cfg);
    expect(conflicts).toHaveLength(0);
  });
});

describe("failure pattern memory", () => {
  it("loadFailurePatterns reads past arbitration events from event log", async () => {
    const { loadFailurePatterns, buildPlannerPrompt } = await import("./planner.js");
    const dir = mkdtempSync(join(tmpdir(), "swarm-failure-"));
    mkdirSync(join(dir, ".swarm"), { recursive: true });
    writeFileSync(join(dir, ".swarm", "events.jsonl"), [
      '{"run_id":"r1","task_id":"t1","type":"ArbitrationRequested","ts":"2025-01-01T00:00:00Z","payload":{"reason":"out_of_scope_edit","outOfScopeFiles":["package.json"]}}',
      '{"run_id":"r1","task_id":"t1","type":"ArbitrationRequested","ts":"2025-01-01T00:00:01Z","payload":{"reason":"budget_exceeded"}}',
    ].join("\n"));

    const patterns = loadFailurePatterns(dir);
    expect(patterns.length).toBeGreaterThanOrEqual(2);
    expect(patterns.some((p) => p.includes("out-of-scope") && p.includes("package.json"))).toBe(true);
    expect(patterns.some((p) => p.includes("budget exceeded"))).toBe(true);

    // Verify patterns are injected into planner prompt
    const cfg = SwarmConfigSchema.parse({ version: "0.1", goal: "g" });
    const prompt = buildPlannerPrompt(cfg, "linux", patterns);
    expect(prompt).toContain("Past failure patterns");
    expect(prompt).toContain("out-of-scope");
    rmSync(dir, { recursive: true, force: true });
  });

  it("loadFailurePatterns returns empty when no event log exists", async () => {
    const { loadFailurePatterns } = await import("./planner.js");
    const dir = mkdtempSync(join(tmpdir(), "swarm-noevents-"));
    expect(loadFailurePatterns(dir)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("deduplicates identical failure patterns", async () => {
    const { loadFailurePatterns } = await import("./planner.js");
    const dir = mkdtempSync(join(tmpdir(), "swarm-dedup-"));
    mkdirSync(join(dir, ".swarm"), { recursive: true });
    writeFileSync(join(dir, ".swarm", "events.jsonl"), [
      '{"run_id":"r1","type":"ArbitrationRequested","ts":"2025-01-01T00:00:00Z","payload":{"reason":"budget_exceeded"}}',
      '{"run_id":"r2","type":"ArbitrationRequested","ts":"2025-01-01T00:00:01Z","payload":{"reason":"budget_exceeded"}}',
    ].join("\n"));
    const patterns = loadFailurePatterns(dir);
    const budgetPatterns = patterns.filter((p) => p.includes("budget exceeded"));
    expect(budgetPatterns).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });
});
