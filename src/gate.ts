import { execa } from "execa";

export type CheckOutcome = "passed" | "failed" | "skipped";

export interface CheckResult {
  command: string;
  outcome: CheckOutcome;
  passed: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  reason?: string;
}

export interface GateVerdict {
  passed: boolean;
  results: CheckResult[];
}

/**
 * Exit codes that typically indicate the *tool itself* was unavailable, rather
 * than a real check failure. Treating these as `skipped` instead of `failed`
 * prevents cross-platform tooling gaps (e.g. `grep` on Windows pwsh) from
 * silently rejecting otherwise-correct work.
 *
 * - 127: POSIX "command not found"
 * - 255: common when execa fails to spawn (Windows pwsh)
 * - 9009: Windows cmd "is not recognized as the name of a cmdlet"
 */
const TOOL_MISSING_EXIT_CODES = new Set<number>([127, 255, 9009]);

const TOOL_MISSING_STDERR_PATTERNS = [
  /command not found/i,
  /is not recognized as (a|an internal or external) (cmdlet|command)/i,
  /no such file or directory/i,
];

function classifyExit(exitCode: number, stderr: string): CheckOutcome {
  if (exitCode === 0) return "passed";
  if (TOOL_MISSING_EXIT_CODES.has(exitCode)) return "skipped";
  if (TOOL_MISSING_STDERR_PATTERNS.some((re) => re.test(stderr))) return "skipped";
  return "failed";
}

/**
 * Run a list of acceptance_checks as shell commands in the given cwd.
 * Each check is treated as a single shell line (executed via the platform shell
 * so things like `grep -q "..." file` and `npm test` both work).
 *
 * MVP semantics:
 * - exit code 0 = pass
 * - any non-zero exit = fail
 * - timeout per check: 2 minutes (test/lint should be much faster)
 *
 * Note: this runs locally on the host (not via the agent), so there is no extra
 * model cost. Make checks deterministic — avoid running the agent again here.
 */
export async function runAcceptanceChecks(
  cwd: string,
  checks: readonly string[],
): Promise<GateVerdict> {
  const results: CheckResult[] = [];
  for (const cmd of checks) {
    const trimmed = cmd.trim();
    if (!trimmed) continue;
    try {
      const r = await execa(trimmed, {
        cwd,
        shell: true,
        reject: false,
        timeout: 2 * 60_000,
        stdin: "ignore",
      });
      const exitCode = r.exitCode ?? -1;
      const stderr = String(r.stderr ?? "").slice(0, 4000);
      const outcome = classifyExit(exitCode, stderr);
      const result: CheckResult = {
        command: trimmed,
        outcome,
        passed: outcome === "passed",
        exitCode,
        stdout: String(r.stdout ?? "").slice(0, 4000),
        stderr,
      };
      if (outcome === "skipped") {
        result.reason = "tool unavailable on host (e.g. command not found)";
      }
      results.push(result);
    } catch (err) {
      results.push({
        command: trimmed,
        outcome: "failed",
        passed: false,
        exitCode: -1,
        stdout: "",
        stderr: (err as Error).message,
      });
    }
  }
  // Gate semantics:
  // - At least one check must have actually `passed` (avoid empty-list = pass).
  // - No check may be `failed` (a real non-zero exit that isn't a tool gap).
  // - `skipped` checks (tool missing) don't count for or against; they surface in the report.
  const anyFailed = results.some((r) => r.outcome === "failed");
  const anyPassed = results.some((r) => r.outcome === "passed");
  const passed = !anyFailed && anyPassed;
  return { passed, results };
}
