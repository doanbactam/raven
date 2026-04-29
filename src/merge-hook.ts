import { execa } from "execa";

export interface PreMergeHookResult {
  passed: boolean;
  results: Array<{
    command: string;
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
}

/**
 * Run pre-merge hook commands before allowing a task branch to merge.
 *
 * Each command receives environment variables:
 * - SWARM_RUN_ID: the run identifier
 * - SWARM_TASK_ID: the task being merged
 * - SWARM_BRANCH: the branch name about to be merged
 *
 * If any command exits non-zero, the merge is rejected.
 */
export async function runPreMergeHooks(
  cwd: string,
  commands: readonly string[],
  env: { runId: string; taskId: string; branch: string },
): Promise<PreMergeHookResult> {
  const results: PreMergeHookResult["results"] = [];
  for (const cmd of commands) {
    const trimmed = cmd.trim();
    if (!trimmed) continue;
    try {
      const r = await execa(trimmed, {
        cwd,
        shell: true,
        reject: false,
        timeout: 5 * 60_000,
        stdin: "ignore",
        env: {
          ...process.env,
          SWARM_RUN_ID: env.runId,
          SWARM_TASK_ID: env.taskId,
          SWARM_BRANCH: env.branch,
        },
      });
      const exitCode = r.exitCode ?? -1;
      results.push({
        command: trimmed,
        exitCode,
        stdout: String(r.stdout ?? "").slice(0, 4000),
        stderr: String(r.stderr ?? "").slice(0, 4000),
      });
      if (exitCode !== 0) {
        return { passed: false, results };
      }
    } catch (err) {
      results.push({
        command: trimmed,
        exitCode: -1,
        stdout: "",
        stderr: (err as Error).message,
      });
      return { passed: false, results };
    }
  }
  return { passed: true, results };
}
