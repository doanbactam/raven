import { execa } from "execa";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type CheckLevel = "ok" | "warn" | "fail";

export interface DoctorCheck {
  name: string;
  level: CheckLevel;
  message: string;
}

/**
 * Pre-flight checks for swarm-cp. Run before `swarm plan` to surface env or
 * config issues that would otherwise produce confusing mid-run failures.
 *
 * - "ok"   = check passed
 * - "warn" = degraded but runnable (e.g. swarm.yaml missing — caller may not
 *            intend to use swarm yet)
 * - "fail" = blocking; doctor exits non-zero
 */
export async function runDoctor(cwd: string): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  // 1. Node version
  const nodeMajor = parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  checks.push({
    name: "node",
    level: nodeMajor >= 22 ? "ok" : "fail",
    message: `Node ${process.versions.node} (require ≥22)`,
  });

  // 2. claude CLI
  checks.push(await checkBin("claude", ["--version"]));

  // 3. git CLI
  checks.push(await checkBin("git", ["--version"]));

  // 4. cwd is a git repo
  const gitDir = join(cwd, ".git");
  checks.push({
    name: "git-repo",
    level: existsSync(gitDir) ? "ok" : "fail",
    message: existsSync(gitDir) ? "cwd is a git repo" : `no .git directory at ${cwd}`,
  });

  // 5. swarm.yaml exists
  const yamlPath = join(cwd, "swarm.yaml");
  const hasYaml = existsSync(yamlPath);
  checks.push({
    name: "swarm.yaml",
    level: hasYaml ? "ok" : "warn",
    message: hasYaml ? "swarm.yaml present" : "swarm.yaml missing — run `swarm init`",
  });

  // 6. .claude/agents/ files
  const agentsDir = join(cwd, ".claude", "agents");
  if (hasYaml) {
    const required = ["swarm-architect.md", "swarm-implementer.md", "swarm-quality-gate.md"];
    const missing = required.filter((f) => !existsSync(join(agentsDir, f)));
    checks.push({
      name: ".claude/agents",
      level: missing.length === 0 ? "ok" : "fail",
      message:
        missing.length === 0
          ? "all subagent templates present"
          : `missing subagent templates: ${missing.join(", ")} — re-run \`swarm init\``,
    });
  }

  // 7. permissions.deny includes secrets
  const settingsPath = join(cwd, ".claude", "settings.json");
  if (existsSync(settingsPath)) {
    try {
      const raw = readFileSync(settingsPath, "utf8");
      const parsed = JSON.parse(raw) as { permissions?: { deny?: string[] } };
      const deny = parsed.permissions?.deny ?? [];
      const wantsEnv = deny.some((d) => /\.env/i.test(d));
      checks.push({
        name: "permissions.deny",
        level: wantsEnv ? "ok" : "warn",
        message: wantsEnv
          ? `${deny.length} deny rule(s) configured`
          : "permissions.deny does not block .env — secrets may leak",
      });
    } catch (err) {
      checks.push({
        name: "permissions.deny",
        level: "fail",
        message: `failed to parse .claude/settings.json: ${(err as Error).message}`,
      });
    }
  }

  // 8. PAGER / GIT_ASKPASS sanity (informational; we already strip them)
  const dangerous = ["PAGER", "GIT_PAGER", "GIT_ASKPASS"].filter((k) => process.env[k]);
  if (dangerous.length > 0) {
    checks.push({
      name: "env-vars",
      level: "warn",
      message: `${dangerous.join(", ")} set in env — swarm strips these for git, but external tools may still trip on them`,
    });
  }

  // 9. git worktree support (Phase 3.3 parity review)
  checks.push(await checkWorktreeSupport(cwd));

  // 10. Claude CLI --include-hook-events support (Phase 3.1)
  checks.push(await checkClaudeHookSupport());

  return checks;
}

async function checkBin(cmd: string, args: string[]): Promise<DoctorCheck> {
  try {
    const r = await execa(cmd, args, { reject: false, timeout: 5000 });
    if (r.exitCode === 0) {
      return {
        name: cmd,
        level: "ok",
        message: `${cmd} found: ${String(r.stdout).split("\n")[0]?.trim()}`,
      };
    }
    return {
      name: cmd,
      level: "fail",
      message: `${cmd} returned exit ${r.exitCode}`,
    };
  } catch (err) {
    return {
      name: cmd,
      level: "fail",
      message: `${cmd} not found on PATH: ${(err as Error).message}`,
    };
  }
}

/**
 * Phase 3.3 decision: manual git worktree is sufficient.
 *
 * Rationale: `git worktree add/remove` gives full isolation, correct branch
 * handling, and no extra dependency. Claude Code does not yet expose a stable
 * WorktreeCreate hook, so migrating would add fragility for zero benefit.
 * Re-evaluate if Claude Code ships a first-class worktree API.
 */
async function checkWorktreeSupport(cwd: string): Promise<DoctorCheck> {
  try {
    const r = await execa("git", ["worktree", "list"], {
      cwd,
      reject: false,
      timeout: 5000,
    });
    if (r.exitCode === 0) {
      const lines = String(r.stdout).trim().split(/\r?\n/).filter(Boolean);
      return {
        name: "git-worktree",
        level: "ok",
        message: `git worktree supported; ${lines.length} worktree(s) active`,
      };
    }
    return {
      name: "git-worktree",
      level: "warn",
      message: `git worktree list exited ${r.exitCode} — worktree isolation may not work`,
    };
  } catch (err) {
    return {
      name: "git-worktree",
      level: "warn",
      message: `git worktree check failed: ${(err as Error).message}`,
    };
  }
}

async function checkClaudeHookSupport(): Promise<DoctorCheck> {
  try {
    const r = await execa("claude", ["--help"], { reject: false, timeout: 5000 });
    const helpText = String(r.stdout ?? "") + String(r.stderr ?? "");
    if (/--include-hook-events/i.test(helpText)) {
      return {
        name: "claude-hooks",
        level: "ok",
        message: "claude CLI supports --include-hook-events",
      };
    }
    return {
      name: "claude-hooks",
      level: "warn",
      message: "claude CLI does not advertise --include-hook-events — lifecycle hooks will be empty",
    };
  } catch {
    return {
      name: "claude-hooks",
      level: "warn",
      message: "claude CLI not available — cannot verify hook support",
    };
  }
}

export function formatChecks(checks: readonly DoctorCheck[]): string {
  const symbols: Record<CheckLevel, string> = { ok: "[OK]  ", warn: "[WARN]", fail: "[FAIL]" };
  return checks.map((c) => `${symbols[c.level]} ${c.name.padEnd(18)} ${c.message}`).join("\n");
}

export function hasFailures(checks: readonly DoctorCheck[]): boolean {
  return checks.some((c) => c.level === "fail");
}
