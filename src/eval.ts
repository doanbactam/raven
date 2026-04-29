import { execa } from "execa";
import { mkdtemp, readFile, mkdir, writeFile, cp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";
import { EvalSuiteSchema, type EvalEntry, type EvalSuite } from "./schema.js";
import { isTransientClaudeError } from "./runner.js";

export interface EvalRunResult {
  entryId: string;
  mode: "baseline" | "swarm";
  runIndex: number;
  /** Wall-clock milliseconds for the whole mode (incl. plan for swarm). */
  wallMs: number;
  /** Total USD across plan + workers (best-effort; 0 if unmeasured). */
  costUsd: number;
  /** Verify command exit code (-1 if no verify_cmd). */
  verifyExit: number;
  /** Working directory the run produced (kept for inspection). */
  workdir: string;
  /** Extra free-form metrics (e.g. swarm task counts). */
  extras: Record<string, unknown>;
}

export async function loadSuite(suitePath: string): Promise<EvalSuite> {
  const raw = await readFile(suitePath, "utf8");
  const parsed = parseYaml(raw);
  return EvalSuiteSchema.parse(parsed);
}

/**
 * Run every entry × mode × runs of an eval suite. Each run is performed in an
 * isolated copy of the fixture under a tempdir, so the source fixtures stay
 * pristine. Results are streamed to JSONL and a summary CSV inside `out_dir`.
 */
export async function runSuite(
  suitePath: string,
  opts: { swarmCli: string; claudeBin?: string } = { swarmCli: "swarm" },
): Promise<EvalRunResult[]> {
  const absSuite = resolve(suitePath);
  const suite = await loadSuite(absSuite);
  const suiteDir = dirname(absSuite);
  const outDir = resolve(suiteDir, suite.out_dir);
  await mkdir(outDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonlPath = join(outDir, `results-${stamp}.jsonl`);
  const csvPath = join(outDir, `results-${stamp}.csv`);

  const results: EvalRunResult[] = [];
  const csvLines = ["entry,mode,run,wall_ms,cost_usd,verify_exit,workdir"];
  const swarmCli = parseCommandSpec(opts.swarmCli, process.cwd());

  for (const entry of suite.entries) {
    const goal = await resolveGoal(entry, suiteDir);
    const fixture = resolve(suiteDir, entry.fixture);
    if (!existsSync(fixture)) throw new Error(`fixture not found: ${fixture}`);

    for (const mode of entry.modes) {
      for (let i = 0; i < entry.runs; i++) {
        // eslint-disable-next-line no-console
        console.log(`[eval] ${entry.id} mode=${mode} run=${i + 1}/${entry.runs}`);
        const r =
          mode === "baseline"
            ? await runBaseline(entry, fixture, goal, opts.claudeBin ?? "claude", i)
            : await runSwarm(entry, fixture, goal, swarmCli, i);
        results.push(r);
        await appendJsonl(jsonlPath, r);
        csvLines.push(
          [r.entryId, r.mode, r.runIndex, r.wallMs, r.costUsd.toFixed(4), r.verifyExit, r.workdir]
            .map(csvEscape)
            .join(","),
        );
        await writeFile(csvPath, csvLines.join("\n") + "\n");
      }
    }
  }

  return results;
}

async function resolveGoal(entry: EvalEntry, suiteDir: string): Promise<string> {
  if (entry.goal) return entry.goal;
  if (entry.goal_file) {
    return await readFile(resolve(suiteDir, entry.goal_file), "utf8");
  }
  throw new Error(`entry ${entry.id} missing both goal and goal_file`);
}

async function runBaseline(
  entry: EvalEntry,
  fixture: string,
  goal: string,
  claudeBin: string,
  runIndex: number,
): Promise<EvalRunResult> {
  const workdir = await mkdtemp(join(tmpdir(), `swarm-eval-${entry.id}-baseline-`));
  await cp(fixture, workdir, { recursive: true });

  const start = Date.now();
  const r = await execaWithTransientRetry(
    claudeBin,
    ["-p", goal, "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"],
    { cwd: workdir, timeout: evalTimeoutMs() },
    evalMaxRetries(),
  );
  const wallMs = Date.now() - start;

  const costUsd = extractCostFromStream(String(r.stdout ?? ""));
  const verifyExit = await runVerify(entry, workdir);

  return {
    entryId: entry.id,
    mode: "baseline",
    runIndex,
    wallMs,
    costUsd,
    verifyExit,
    workdir,
    extras: {
      exitCode: r.exitCode ?? -1,
      stdoutTail: tail(String(r.stdout ?? ""), 2000),
      stderrTail: tail(String(r.stderr ?? ""), 2000),
      timedOut: Boolean(r.timedOut),
    },
  };
}

async function runSwarm(
  entry: EvalEntry,
  fixture: string,
  goal: string,
  swarmCli: CommandSpec,
  runIndex: number,
): Promise<EvalRunResult> {
  const workdir = await mkdtemp(join(tmpdir(), `swarm-eval-${entry.id}-swarm-`));
  await cp(fixture, workdir, { recursive: true });

  // Ensure workdir is a git repo (required for worktrees, plan, merge).
  await execa("git", ["init"], { cwd: workdir, reject: false });
  await execa("git", ["config", "user.email", "eval@swarm-cp.local"], { cwd: workdir, reject: false });
  await execa("git", ["config", "user.name", "Swarm Eval"], { cwd: workdir, reject: false });
  await execa("git", ["add", "-A"], { cwd: workdir, reject: false });
  await execa("git", ["commit", "-m", "initial fixture", "--allow-empty"], { cwd: workdir, reject: false });

  // Init swarm scaffold + write goal into swarm.yaml (replace stock goal).
  const initRes = await execa(swarmCli.command, [...swarmCli.args, "init"], { cwd: workdir, reject: false });
  if (initRes.exitCode !== 0) {
    return {
      entryId: entry.id,
      mode: "swarm",
      runIndex,
      wallMs: 0,
      costUsd: 0,
      verifyExit: -1,
      workdir,
      extras: {
        initExitCode: initRes.exitCode ?? -1,
        initStdoutTail: tail(String(initRes.stdout ?? ""), 2000),
        initStderrTail: tail(String(initRes.stderr ?? ""), 2000),
        initTimedOut: Boolean(initRes.timedOut),
      },
    };
  }
  const yamlPath = join(workdir, "swarm.yaml");
  const yamlIn = await readFile(yamlPath, "utf8");
  const yamlOut = yamlIn.replace(/goal:.*/, `goal: |\n${goal.split("\n").map((l) => `  ${l}`).join("\n")}`);
  await writeFile(yamlPath, yamlOut);

  const start = Date.now();
  // Plan
  const planRes = await execa(swarmCli.command, [...swarmCli.args, "plan"], {
    cwd: workdir,
    reject: false,
    timeout: evalTimeoutMs(),
    stdin: "ignore",
  });
  const runId = /Run ID:\s+([\w-]+)/.exec(String(planRes.stdout))?.[1] ?? "";
  const planCost = parseFloat(/planner cost:\s*\$([\d.]+)/.exec(String(planRes.stdout))?.[1] ?? "0");

  // Run
  let runOk = false;
  let runErr = "";
  if (runId) {
    const runRes = await execa(swarmCli.command, [...swarmCli.args, "run", runId], {
      cwd: workdir,
      reject: false,
      timeout: evalTimeoutMs(),
      stdin: "ignore",
    });
    runOk = runRes.exitCode === 0;
    runErr = String(runRes.stderr ?? "");
  } else {
    runErr = "no run id parsed from plan output";
  }
  // Best-effort merge so verify_cmd sees committed state
  if (runId) {
    await execa(swarmCli.command, [...swarmCli.args, "merge", runId], { cwd: workdir, reject: false });
  }
  const wallMs = Date.now() - start;

  // Sum worker cost from event log
  const workerCost = await sumWorkerCost(join(workdir, ".swarm", "events.jsonl"));
  const costUsd = planCost + workerCost;
  const verifyExit = await runVerify(entry, workdir);

  return {
    entryId: entry.id,
    mode: "swarm",
    runIndex,
    wallMs,
    costUsd,
    verifyExit,
    workdir,
    extras: {
      runId,
      runOk,
      runErr: runErr.slice(0, 500),
      planCost,
      workerCost,
      planExitCode: planRes.exitCode ?? -1,
      planStdoutTail: tail(String(planRes.stdout ?? ""), 2000),
      planStderrTail: tail(String(planRes.stderr ?? ""), 2000),
      planTimedOut: Boolean(planRes.timedOut),
    },
  };
}

async function runVerify(entry: EvalEntry, workdir: string): Promise<number> {
  if (!entry.verify_cmd) return -1;
  const r = await execa(entry.verify_cmd, {
    cwd: workdir,
    shell: true,
    reject: false,
    timeout: 5 * 60_000,
  });
  return r.exitCode ?? -1;
}

function extractCostFromStream(stdout: string): number {
  // Walk lines; take the highest total_cost_usd seen from any event type.
  // "result" events carry the final total, but partial/timed-out streams may
  // only have cost on intermediate events. Use the max to be robust.
  let cost = 0;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const obj = JSON.parse(trimmed) as { type?: string; total_cost_usd?: number };
      if (typeof obj.total_cost_usd === "number" && obj.total_cost_usd > cost) {
        cost = obj.total_cost_usd;
      }
    } catch {
      // skip malformed lines
    }
  }
  return cost;
}

async function sumWorkerCost(eventsPath: string): Promise<number> {
  if (!existsSync(eventsPath)) return 0;
  const raw = await readFile(eventsPath, "utf8");
  let total = 0;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const e = JSON.parse(trimmed) as { type?: string; payload?: { costUsd?: number } };
      if (
        (e.type === "TaskValidated" || e.type === "TaskFailed") &&
        typeof e.payload?.costUsd === "number"
      ) {
        total += e.payload.costUsd;
      }
    } catch {
      // skip
    }
  }
  return total;
}

async function appendJsonl(path: string, obj: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(obj) + "\n", { flag: "a" });
}

function csvEscape(v: string | number): string {
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function modeSucceeded(r: EvalRunResult): boolean {
  if (r.mode === "baseline") return r.extras.exitCode === 0;
  return r.extras.planExitCode === 0 && r.extras.runOk === true;
}

interface CommandSpec {
  command: string;
  args: string[];
}

function parseCommandSpec(spec: string, baseDir: string): CommandSpec {
  const parts = spec.match(/"[^"]+"|'[^']+'|\S+/g)?.map((p) => p.replace(/^["']|["']$/g, "")) ?? [];
  if (parts.length === 0) throw new Error("empty command spec");
  const command = parts[0]!;
  const args = parts.slice(1);
  return {
    command,
    args: args.map((arg) => (looksLikeRelativeScriptPath(arg) ? resolve(baseDir, arg) : arg)),
  };
}

function looksLikeRelativeScriptPath(arg: string): boolean {
  return !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(arg) && !arg.startsWith("/") && /\.(c?js|mjs|ts)$/.test(arg);
}

async function execaWithTransientRetry(
  command: string,
  args: string[],
  opts: { cwd: string; timeout: number },
  maxRetries = 2,
): Promise<{ exitCode?: number; stdout?: string; stderr?: string; timedOut?: boolean }> {
  let result: { exitCode?: number; stdout?: string; stderr?: string; timedOut?: boolean } | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    result = await execa(command, args, {
      cwd: opts.cwd,
      reject: false,
      timeout: opts.timeout,
      stdin: "ignore",
    });
    // Don't retry if: success, timed out, or stderr doesn't indicate transient error.
    // IMPORTANT: only check stderr, NOT stdout — stdout contains Claude CLI's own
    // internal retry logs (api_retry error_status:429) which would false-positive.
    if (
      result.exitCode === 0 ||
      result.timedOut ||
      !isTransientClaudeError({ stdout: "", stderr: String(result.stderr ?? "") }) ||
      attempt === maxRetries
    ) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  return result!;
}

function evalTimeoutMs(): number {
  const raw = process.env.SWARM_EVAL_TIMEOUT_MS;
  if (!raw) return 30 * 60_000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30 * 60_000;
}

function evalMaxRetries(): number {
  const raw = process.env.SWARM_EVAL_MAX_RETRIES;
  if (!raw) return 2;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 2;
}

function tail(s: string, max: number): string {
  return s.length <= max ? s : s.slice(s.length - max);
}

/** Test helper. */
export const _internals = {
  extractCostFromStream,
  sumWorkerCost,
  csvEscape,
  parseCommandSpec,
  modeSucceeded,
  evalTimeoutMs,
  evalMaxRetries,
};

// re-export so deletion logic / cleanup can reuse if ever needed
export { rm };
