import { simpleGit, type SimpleGit } from "simple-git";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * Worktree service: tạo git worktree cô lập per-task.
 * MVP: dùng simple-git. Tương lai: tích hợp với `claude --worktree` hoặc
 * Claude Code WorktreeCreate hook để planner tự xử lý lifecycle.
 */
export class WorktreeService {
  private git: SimpleGit;
  private rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = resolve(rootDir);
    this.git = simpleGit(this.rootDir);
    this.git.env(sanitizedEnv());
  }

  /** Tạo worktree mới ở `.swarm/worktrees/<taskId>` từ branch hiện tại. */
  async create(runId: string, taskId: string): Promise<string> {
    const wtDir = join(this.rootDir, ".swarm", "worktrees", runId, taskId);
    await mkdir(join(this.rootDir, ".swarm", "worktrees", runId), { recursive: true });
    const branch = `swarm/${runId}/${taskId}`;
    // On resume, the branch/worktree may already exist from a previous attempt.
    // Clean up the old worktree and branch before creating a new one.
    try {
      await this.git.raw(["worktree", "remove", "--force", wtDir]);
    } catch {
      // Fallback: manual removal if git couldn't (e.g. locked dir on Windows).
      await rm(wtDir, { recursive: true, force: true });
    }
    try {
      await this.git.raw(["branch", "-D", branch]);
    } catch {
      // branch didn't exist, that's fine
    }
    // -b tạo branch mới từ HEAD
    await this.git.raw(["worktree", "add", "-b", branch, wtDir]);
    return wtDir;
  }

  async remove(wtDir: string): Promise<void> {
    try {
      await this.git.raw(["worktree", "remove", "--force", wtDir]);
    } catch {
      // fallback: xóa thủ công nếu git không quản lý
      await rm(wtDir, { recursive: true, force: true });
    }
  }

  /** Conventional branch name for a task, matching `create()`. */
  branchName(runId: string, taskId: string): string {
    return `swarm/${runId}/${taskId}`;
  }

  /**
   * Stage all changes inside a worktree and commit them.
   * Returns false if there were no changes to commit.
   */
  async commitAll(wtDir: string, message: string): Promise<boolean> {
    const wtGit = simpleGit(wtDir).env(sanitizedEnv());
    await wtGit.add(["-A"]);
    const status = await wtGit.status();
    if (status.files.length === 0) return false;
    // simple-git refuses to run when PAGER is set unless `allowUnsafePager` is true.
    // Strip it (and friends) from the env we hand off so commits never trip on it.
    const env = sanitizedEnv();
    env.GIT_AUTHOR_NAME = "swarm-cp";
    env.GIT_AUTHOR_EMAIL = "swarm@local";
    env.GIT_COMMITTER_NAME = "swarm-cp";
    env.GIT_COMMITTER_EMAIL = "swarm@local";
    await wtGit.env(env).commit(message);
    return true;
  }

  /** Return changed paths in a worktree before commit, relative to the repo root. */
  async changedFiles(wtDir: string): Promise<string[]> {
    const wtGit = simpleGit(wtDir).env(sanitizedEnv());
    const status = await wtGit.status();
    return Array.from(new Set(status.files.map((f) => f.path.replace(/\\/g, "/")))).sort();
  }

  /** Merge `swarm/<runId>/<taskId>` into the current branch (--no-ff). */
  async mergeBranch(runId: string, taskId: string): Promise<{ ok: boolean; message: string }> {
    const branch = this.branchName(runId, taskId);
    try {
      const r = await this.git.raw([
        "merge",
        "--no-ff",
        "-m",
        `swarm: merge ${taskId} (${runId})`,
        branch,
      ]);
      return { ok: true, message: r.trim() };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  /** Delete the local branch (used after merge or for clean). */
  async deleteBranch(runId: string, taskId: string, force = false): Promise<void> {
    const branch = this.branchName(runId, taskId);
    try {
      await this.git.raw(["branch", force ? "-D" : "-d", branch]);
    } catch {
      // ignore — branch may already be gone
    }
  }
}

/**
 * Build a child env for git that omits all variables simple-git rejects as
 * "unsafe". The `--allow-unsafe-*` opt-in flags are intentionally NOT used
 * here; it is safer to strip the variables so child git invocations behave
 * the same regardless of the parent shell's environment.
 *
 * Reference: simple-git's UnsafeCommands check.
 */
function sanitizedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const blocked = [
    "PAGER",
    "GIT_PAGER",
    "GIT_ASKPASS",
    "SSH_ASKPASS",
    "GIT_PROXY_COMMAND",
    "GIT_EXTERNAL_DIFF",
    "GIT_SSH_COMMAND",
    "GIT_EDITOR",
    "EDITOR",
    "VISUAL",
  ];
  for (const k of blocked) delete env[k];
  return env;
}
