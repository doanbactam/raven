# Agent control-plane benchmark

## Purpose

`swarm-cp` should feel like a local agent control-plane, not a chat transcript. The user needs to know what was planned, what is running, what needs attention, and what evidence is ready for review.

## Benchmarked products

| Product | Task creation | Tracking | Failure recovery | Review / merge | Trust evidence |
| --- | --- | --- | --- | --- | --- |
| OpenAI Codex | Launch tasks locally, from the IDE/CLI, or in cloud environments connected to a repo. | Users can monitor real-time logs or let work continue in the background. | Cloud task flow keeps task state separate from the prompt surface. | Completed tasks are reviewed as diffs and can become PRs or local branches. | Logs, changed files, branch checkout, and diff review. |
| Cursor Background Agents | Creates background agents from editor, web, or mobile prompts against a repo. | Shows asynchronous agent progress outside the foreground editor session. | Agent runs can be resumed or managed when the original interaction context changes. | Output is brought back to the repo workflow for review. | Agent activity, branch/worktree context, and resulting code changes. |
| GitHub Copilot coding agent | Starts from GitHub issues or assigned tasks. | Progress is visible in GitHub's native issue/PR workflow. | Failures stay attached to issue and PR context. | Produces pull requests for human review. | PR diff, commits, checks, comments, and issue linkage. |
| Claude Code GitHub Actions | Runs Claude from GitHub Actions comments and workflow triggers. | Uses GitHub Actions logs and PR/issue updates. | Failed runs are diagnosed through workflow logs and rerun with adjusted prompts. | Changes land in normal GitHub review surfaces. | Action logs, bot comments, branch diffs, and CI results. |

Sources: [OpenAI Codex docs](https://developers.openai.com/codex/quickstart), [Cursor Background Agents](https://docs.cursor.com/en/background-agents), [GitHub Copilot coding agent](https://docs.github.com/en/copilot/how-tos/agents/copilot-coding-agent), [Claude Code GitHub Actions](https://docs.claude.com/en/docs/claude-code/github-actions).

## Implications for swarm-cp

| Criterion | Current risk | Product direction |
| --- | --- | --- |
| Orientation | A chat/log layout makes the selected run feel like a transcript, so users have to infer the workflow. | Put the selected run goal, status, and next action at the top. |
| State scanning | A flat run list hides which runs need attention. | Group runs by `Needs attention`, `Running`, `Ready`, and `Done`. |
| Action semantics | Generic `Execute` and `Resume` labels do not say what will happen. | Use explicit labels: `Run workers`, `Resume failed tasks`, `Resume pending work`. |
| Evidence | Raw event names are useful for debugging but weak for review. | Separate task evidence, touched files, and a human-readable activity timeline. |
| Continuity | Auto-scrolling to the newest event pulls users away from the run summary. | Keep the dashboard anchored at the top; let activity be expanded intentionally. |

## Non-goals

- Do not add hosted GitHub PR workflow in this pass.
- Do not add more configuration controls.
- Do not change the local-first worktree model.
- Do not hide raw event types; keep them as secondary evidence for debugging.
