import React from "react";
import type { RunSummary } from "../types";

interface SidebarProps {
  runs: RunSummary[];
  selectedRunId: string | null;
  onSelectRun: (runId: string) => void;
  busy: boolean;
}

type RunGroup = {
  label: string;
  runs: RunSummary[];
};

export function Sidebar({ runs, selectedRunId, onSelectRun }: SidebarProps) {
  const groups = groupRuns(runs);

  return (
    <div className="hidden sm:flex sm:w-64 shrink-0 border-r border-border bg-surface-1/50 flex-col">
      <div className="flex items-center justify-between px-3 py-2.5">
        <span className="text-[10px] font-semibold text-text-muted uppercase tracking-widest">
          Control plane
        </span>
        {runs.length > 0 && (
          <span className="text-[10px] text-text-muted/60 tabular-nums">{runs.length}</span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-1.5 pb-2">
        {runs.length === 0 ? (
          <div className="px-3 py-12 text-center">
            <div className="text-text-muted text-[11px] leading-relaxed">
              No runs yet.
              <br />
              Create a plan from a goal.
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {groups.map((group) => (
              <RunSection
                key={group.label}
                group={group}
                selectedRunId={selectedRunId}
                onSelectRun={onSelectRun}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function RunSection({
  group,
  selectedRunId,
  onSelectRun,
}: {
  group: RunGroup;
  selectedRunId: string | null;
  onSelectRun: (runId: string) => void;
}) {
  if (group.runs.length === 0) return null;

  return (
    <section>
      <div className="flex items-center gap-2 px-2 py-1">
        <span className="text-[9px] font-semibold text-text-muted/60 uppercase tracking-widest">
          {group.label}
        </span>
        <span className="text-[9px] text-text-muted/40 tabular-nums ml-auto">
          {group.runs.length}
        </span>
      </div>
      <div className="space-y-0.5">
        {group.runs.map((run) => (
          <RunItem
            key={run.id}
            run={run}
            active={run.id === selectedRunId}
            onClick={() => onSelectRun(run.id)}
          />
        ))}
      </div>
    </section>
  );
}

function groupRuns(runs: RunSummary[]): RunGroup[] {
  const groups: RunGroup[] = [
    { label: "Needs attention", runs: [] },
    { label: "Running", runs: [] },
    { label: "Ready", runs: [] },
    { label: "Done", runs: [] },
  ];

  for (const run of runs) {
    if (needsAttention(run)) groups[0].runs.push(run);
    else if (run.status === "running") groups[1].runs.push(run);
    else if (run.status === "ready") groups[2].runs.push(run);
    else groups[3].runs.push(run);
  }

  return groups;
}

function needsAttention(run: RunSummary) {
  return (
    run.status === "failed" ||
    run.status === "incomplete" ||
    (run.counts.failed ?? 0) > 0 ||
    (run.counts.needs_arbitration ?? 0) > 0
  );
}

function relativeTime(iso: string): string {
  const ms = Math.max(Date.now() - new Date(iso).getTime(), 0);
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return "now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

function RunItem({
  run,
  active,
  onClick,
}: {
  run: RunSummary;
  active: boolean;
  onClick: () => void;
}) {
  const done = run.counts.done ?? 0;
  const failed = (run.counts.failed ?? 0) + (run.counts.needs_arbitration ?? 0);
  const total = run.taskCount;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const attention = needsAttention(run);
  const goal =
    run.goal.trim().toLowerCase() === "describe your goal here"
      ? "Untitled run"
      : run.goal;
  const statusColor =
    attention
      ? "bg-danger"
      : run.status === "running"
        ? "bg-info"
        : run.status === "ready"
          ? "bg-accent"
          : run.status === "done"
            ? "bg-success"
            : "bg-text-muted";

  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-2.5 py-2 rounded-lg transition-all ${
        active
          ? "bg-surface-2 text-text-primary"
          : attention
            ? "hover:bg-danger-soft text-text-secondary"
            : "hover:bg-surface-2/50 text-text-secondary"
      }`}
    >
      <div className="flex items-center gap-1.5 mb-1">
        <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusColor}`} />
        <span className={`text-[10px] font-mono truncate ${active ? "text-text-secondary" : "text-text-muted"}`}>
          {run.id.slice(0, 8)}
        </span>
        <span className="text-[10px] text-text-muted/50 ml-auto shrink-0">
          {relativeTime(run.updated_at)}
        </span>
      </div>

      <div className={`text-[11px] leading-snug truncate ${active ? "text-text-primary" : "text-text-secondary/85"}`}>
        {goal.length > 58 ? goal.slice(0, 55) + "..." : goal}
      </div>

      {total > 0 && (
        <div className="flex items-center gap-2 mt-1.5">
          <div className="flex-1 h-[3px] bg-surface-3 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${failed > 0 ? "bg-danger/75" : "bg-success/70"}`}
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="text-[9px] text-text-muted tabular-nums shrink-0">
            {failed > 0 ? `${failed}!` : `${done}/${total}`}
          </span>
        </div>
      )}
    </button>
  );
}
