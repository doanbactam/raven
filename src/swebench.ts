import { execa } from "execa";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";
import { isTransientClaudeError } from "./runner.js";

/**
 * SWE-bench Verified harness adapter.
 *
 * Each "instance" represents a real GitHub issue + repo snapshot. The harness:
 * 1. Clones the repo (or reuses a cache) at `base_commit`.
 * 2. Runs baseline (single Claude) and/or swarm on the `problem_statement`.
 * 3. Applies `test_patch` and runs `test_cmd` to verify correctness.
 * 4. Reports pass/fail, cost, wall-clock per instance × mode.
 *
 * Instances are defined in a YAML file matching SWEBenchSuiteSchema.
 */

export interface SWEBenchInstance {
  /** Unique identifier, e.g. "django__django-16527". */
  instance_id: string;
  /** GitHub repo slug, e.g. "django/django". */
  repo: string;
  /** Commit SHA to check out before the agent works. */
  base_commit: string;
  /** Natural-language problem statement (the issue body). */
  problem_statement: string;
  /** Unified diff to apply AFTER the agent finishes, containing test cases. */
  test_patch: string;
  /** Shell command to run the test(s), e.g. "python -m pytest tests/...". */
  test_cmd: string;
  /** Modes to run. Default: both. */
  modes?: Array<"baseline" | "swarm">;
  /** Timeout override in ms for this instance. */
  timeout_ms?: number;
}

export interface SWEBenchSuite {
  version: "0.1";
  out_dir: string;
  /** Optional git mirror/cache directory to avoid re-cloning. */
  repo_cache_dir?: string;
  instances: SWEBenchInstance[];
}

export interface SWEBenchRunResult {
  instance_id: string;
  mode: "baseline" | "swarm";
  wallMs: number;
  costUsd: number;
  /** Whether the test_patch tests passed after the agent's work. */
  testPassed: boolean;
  testExitCode: number;
  /** Whether the agent exited cleanly. */
  agentExitCode: number;
  workdir: string;
  extras: Record<string, unknown>;
}

export async function loadSWEBenchSuite(suitePath: string): Promise<SWEBenchSuite> {
  const raw = await readFile(suitePath, "utf8");
  const parsed = parseYaml(raw);
  // Validate required fields exist — full Zod schema would be better but
  // this catches the most common issues (missing fields, wrong types).
  if (!parsed || typeof parsed !== "object") throw new Error("SWE-bench suite: invalid YAML — expected an object");
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.instances)) throw new Error("SWE-bench suite: missing or invalid 'instances' array");
  for (const inst of obj.instances as Record<string, unknown>[]) {
    if (typeof inst.instance_id !== "string") throw new Error("SWE-bench suite: instance missing 'instance_id'");
    if (typeof inst.repo !== "string") throw new Error(`SWE-bench suite: ${inst.instance_id ?? "?"} missing 'repo'`);
    if (typeof inst.base_commit !== "string") throw new Error(`SWE-bench suite: ${inst.instance_id ?? "?"} missing 'base_commit'`);
    if (typeof inst.problem_statement !== "string") throw new Error(`SWE-bench suite: ${inst.instance_id ?? "?"} missing 'problem_statement'`);
    if (typeof inst.test_patch !== "string") throw new Error(`SWE-bench suite: ${inst.instance_id ?? "?"} missing 'test_patch'`);
    if (typeof inst.test_cmd !== "string") throw new Error(`SWE-bench suite: ${inst.instance_id ?? "?"} missing 'test_cmd'`);
  }
  return parsed as SWEBenchSuite;
}

/**
 * Run a SWE-bench suite: for each instance × mode, prepare repo, run agent, apply test patch, verify.
 */
export async function runSWEBenchSuite(
  suitePath: string,
  opts: { swarmCli: string; claudeBin?: string },
): Promise<SWEBenchRunResult[]> {
  const absSuite = resolve(suitePath);
  const suite = await loadSWEBenchSuite(absSuite);
  const suiteDir = dirname(absSuite);
  const outDir = resolve(suiteDir, suite.out_dir);
  await mkdir(outDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonlPath = join(outDir, `swebench-${stamp}.jsonl`);
  const csvPath = join(outDir, `swebench-${stamp}.csv`);

  const results: SWEBenchRunResult[] = [];
  const csvLines = ["instance_id,mode,wall_ms,cost_usd,test_passed,test_exit,agent_exit,workdir"];

  for (const inst of suite.instances) {
    const modes = inst.modes ?? ["baseline", "swarm"];
    for (const mode of modes) {
      console.log(`[swebench] ${inst.instance_id} mode=${mode}`);
      const r = await runInstance(inst, mode, opts, suite.repo_cache_dir);
      results.push(r);
      await appendLine(jsonlPath, JSON.stringify(r));
      csvLines.push(
        [
          r.instance_id, r.mode, r.wallMs, r.costUsd.toFixed(4),
          r.testPassed, r.testExitCode, r.agentExitCode, r.workdir,
        ].map(csvEscape).join(","),
      );
      await writeFile(csvPath, csvLines.join("\n") + "\n");
    }
  }

  return results;
}

async function runInstance(
  inst: SWEBenchInstance,
  mode: "baseline" | "swarm",
  opts: { swarmCli: string; claudeBin?: string },
  repoCacheDir?: string,
): Promise<SWEBenchRunResult> {
  const workdir = await mkdtemp(join(tmpdir(), `swebench-${inst.instance_id}-${mode}-`));
  const timeoutMs = inst.timeout_ms ?? 30 * 60_000;

  try {
    // Step 1: Clone repo at base_commit
    await prepareRepo(inst.repo, inst.base_commit, workdir, repoCacheDir);

    // Step 2: Run the agent (baseline or swarm)
    const start = Date.now();
    let agentExitCode: number;
    let costUsd = 0;
    const extras: Record<string, unknown> = {};

    if (mode === "baseline") {
      const r = await execaRetry(
        opts.claudeBin ?? "claude",
        ["-p", inst.problem_statement, "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"],
        { cwd: workdir, timeout: timeoutMs },
      );
      agentExitCode = r.exitCode ?? -1;
      costUsd = extractCost(String(r.stdout ?? ""));
      extras.stdoutTail = tail(String(r.stdout ?? ""), 2000);
      extras.stderrTail = tail(String(r.stderr ?? ""), 2000);
    } else {
      // Swarm mode: init → plan → run → merge
      const swarmCli = parseCmd(opts.swarmCli, process.cwd());
      await execa(swarmCli.cmd, [...swarmCli.args, "init"], { cwd: workdir, reject: false });

      // Inject goal into swarm.yaml using proper YAML parse/serialize (not fragile regex)
      const yamlPath = join(workdir, "swarm.yaml");
      if (existsSync(yamlPath)) {
        const yamlIn = await readFile(yamlPath, "utf8");
        const yamlObj = parseYaml(yamlIn) as Record<string, unknown>;
        yamlObj.goal = inst.problem_statement;
        const { stringify: stringifyYaml } = await import("yaml");
        await writeFile(yamlPath, stringifyYaml(yamlObj));
      }

      const planRes = await execa(swarmCli.cmd, [...swarmCli.args, "plan"], {
        cwd: workdir, reject: false, timeout: timeoutMs, stdin: "ignore",
      });
      const runId = /Run ID:\s+([\w-]+)/.exec(String(planRes.stdout))?.[1] ?? "";
      extras.planExitCode = planRes.exitCode ?? -1;

      if (runId) {
        const runRes = await execa(swarmCli.cmd, [...swarmCli.args, "run", runId], {
          cwd: workdir, reject: false, timeout: timeoutMs, stdin: "ignore",
        });
        extras.runExitCode = runRes.exitCode ?? -1;
        extras.runOk = runRes.exitCode === 0;
        await execa(swarmCli.cmd, [...swarmCli.args, "merge", runId], { cwd: workdir, reject: false });
      }

      agentExitCode = runId ? (extras.runExitCode as number) : (extras.planExitCode as number);
      costUsd = await sumSwarmCost(join(workdir, ".swarm", "events.jsonl"));
      extras.runId = runId;
    }

    const wallMs = Date.now() - start;

    // Step 3: Apply test patch and run tests
    const { testPassed, testExitCode } = await applyAndTest(workdir, inst.test_patch, inst.test_cmd);

    return {
      instance_id: inst.instance_id,
      mode,
      wallMs,
      costUsd,
      testPassed,
      testExitCode,
      agentExitCode,
      workdir,
      extras,
    };
  } catch (err) {
    return {
      instance_id: inst.instance_id,
      mode,
      wallMs: 0,
      costUsd: 0,
      testPassed: false,
      testExitCode: -1,
      agentExitCode: -1,
      workdir,
      extras: { error: (err as Error).message },
    };
  }
}

async function prepareRepo(
  repoSlug: string,
  baseCommit: string,
  workdir: string,
  cacheDir?: string,
): Promise<void> {
  const url = `https://github.com/${repoSlug}.git`;
  if (cacheDir) {
    const cached = join(cacheDir, repoSlug.replace("/", "__"));
    if (!existsSync(cached)) {
      await mkdir(dirname(cached), { recursive: true });
      await execa("git", ["clone", "--bare", url, cached], { timeout: 10 * 60_000 });
    } else {
      await execa("git", ["fetch", "--all"], { cwd: cached, reject: false, timeout: 5 * 60_000 });
    }
    await execa("git", ["clone", cached, workdir], { timeout: 5 * 60_000 });
  } else {
    await execa("git", ["clone", url, workdir], { timeout: 10 * 60_000 });
  }
  await execa("git", ["checkout", baseCommit], { cwd: workdir });
  await execa("git", ["config", "user.email", "swebench@local"], { cwd: workdir });
  await execa("git", ["config", "user.name", "SWE-bench Harness"], { cwd: workdir });
}

async function applyAndTest(
  workdir: string,
  testPatch: string,
  testCmd: string,
): Promise<{ testPassed: boolean; testExitCode: number }> {
  if (testPatch.trim()) {
    const patchPath = join(workdir, ".swebench-test.patch");
    await writeFile(patchPath, testPatch);
    const applyRes = await execa("git", ["apply", "--allow-empty", patchPath], {
      cwd: workdir,
      reject: false,
      timeout: 60_000,
    });
    if (applyRes.exitCode !== 0) {
      // Try with 3-way merge fallback
      const fallbackRes = await execa("git", ["apply", "--3way", patchPath], { cwd: workdir, reject: false, timeout: 60_000 });
      if (fallbackRes.exitCode !== 0) {
        return { testPassed: false, testExitCode: -1 };
      }
    }
  }

  const testRes = await execa(testCmd, {
    cwd: workdir,
    shell: true,
    reject: false,
    timeout: 10 * 60_000,
    stdin: "ignore",
  });
  const exitCode = testRes.exitCode ?? -1;
  return { testPassed: exitCode === 0, testExitCode: exitCode };
}

async function sumSwarmCost(eventsPath: string): Promise<number> {
  if (!existsSync(eventsPath)) return 0;
  const raw = await readFile(eventsPath, "utf8");
  let total = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as { type?: string; payload?: { costUsd?: number } };
      if (
        (e.type === "TaskValidated" || e.type === "TaskFailed" || e.type === "ArbitrationRequested") &&
        typeof e.payload?.costUsd === "number"
      ) total += e.payload.costUsd;
    } catch { /* skip */ }
  }
  return total;
}

async function execaRetry(
  cmd: string,
  args: string[],
  opts: { cwd: string; timeout: number },
  maxRetries = 2,
): Promise<{ exitCode?: number; stdout?: string; stderr?: string; timedOut?: boolean }> {
  let result: { exitCode?: number; stdout?: string; stderr?: string; timedOut?: boolean } | undefined;
  for (let i = 0; i <= maxRetries; i++) {
    result = await execa(cmd, args, { cwd: opts.cwd, reject: false, timeout: opts.timeout, stdin: "ignore" });
    if (
      result.exitCode === 0 ||
      result.timedOut ||
      !isTransientClaudeError({ stdout: "", stderr: String(result.stderr ?? "") }) ||
      i === maxRetries
    ) return result;
    await new Promise((r) => setTimeout(r, 5000));
  }
  return result!;
}

function extractCost(stdout: string): number {
  let cost = 0;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const o = JSON.parse(line) as { type?: string; total_cost_usd?: number };
      if (typeof o.total_cost_usd === "number" && o.total_cost_usd > cost) cost = o.total_cost_usd;
    } catch { /* skip */ }
  }
  return cost;
}

function parseCmd(spec: string, baseDir: string): { cmd: string; args: string[] } {
  const parts = spec.match(/"[^"]+"|'[^']+'|\S+/g)?.map((p) => p.replace(/^["']|["']$/g, "")) ?? [];
  const cmd = parts[0] ?? "swarm";
  const args = parts.slice(1).map((a) =>
    !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(a) && !a.startsWith("/") && /\.(c?js|mjs|ts)$/.test(a)
      ? resolve(baseDir, a)
      : a,
  );
  return { cmd, args };
}

function csvEscape(v: string | number | boolean): string {
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function appendLine(path: string, line: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, line + "\n", { flag: "a" });
}

function tail(s: string, max: number): string {
  return s.length <= max ? s : s.slice(s.length - max);
}

/**
 * Print a summary table from SWE-bench results.
 */
export function formatSWEBenchSummary(results: SWEBenchRunResult[]): string {
  const lines: string[] = ["# SWE-bench Results Summary", ""];
  const byMode = new Map<string, SWEBenchRunResult[]>();
  for (const r of results) {
    const arr = byMode.get(r.mode) ?? [];
    arr.push(r);
    byMode.set(r.mode, arr);
  }

  for (const [mode, runs] of byMode) {
    const passed = runs.filter((r) => r.testPassed).length;
    const total = runs.length;
    if (total === 0) continue;
    const avgCost = runs.reduce((a, r) => a + r.costUsd, 0) / total;
    const avgWall = runs.reduce((a, r) => a + r.wallMs, 0) / total;
    lines.push(`## ${mode}`);
    lines.push(`- Pass rate: ${passed}/${total} (${((passed / total) * 100).toFixed(1)}%)`);
    lines.push(`- Avg cost: $${avgCost.toFixed(4)}`);
    lines.push(`- Avg wall-clock: ${(avgWall / 1000).toFixed(1)}s`);
    lines.push("");
  }

  lines.push("## Per-instance");
  lines.push("| Instance | Mode | Pass | Cost | Wall (s) |");
  lines.push("|---|---|---|---|---|");
  for (const r of results) {
    lines.push(
      `| ${r.instance_id} | ${r.mode} | ${r.testPassed ? "✅" : "❌"} | $${r.costUsd.toFixed(4)} | ${(r.wallMs / 1000).toFixed(1)} |`,
    );
  }
  return lines.join("\n");
}
