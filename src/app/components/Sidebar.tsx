import React from "react";
import type { RunSummary } from "../types";

interface SidebarProps {
  runs: RunSummary[];
  selectedRunId: string | null;
  onSelectRun: (runId: string) => void;
  busy: boolean;
}

export function Sidebar({ runs, selectedRunId, onSelectRun, busy }: SidebarProps) {
  return (
    <div className="w-60 shrink-0 border-r border-border bg-surface-1/50 flex flex-col">
      <div className="flex items-center justify-between px-3 py-2.5">
        <span className="text-[10px] font-semibold text-text-muted uppercase tracking-widest">
          Runs
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
              Enter a goal to create one.
            </div>
          </div>
        ) : (
          <div className="space-y-0.5">
            {runs.map((run) => (
              <SessionItem
                key={run.id}
                run={run}
                active={run.id === selectedRunId}
                onClick={() => onSelectRun(run.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return "now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

function SessionItem({
  run,
  active,
  onClick,
}: {
  run: RunSummary;
  active: boolean;
  onClick: () => void;
}) {
  const done = run.counts.done ?? 0;
  const total = run.taskCount;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  const statusColor =
    run.status === "done" || run.status === "ready"
      ? "bg-success"
      : run.status === "running"
        ? "bg-info"
        : run.status === "failed"
          ? "bg-danger"
          : "bg-text-muted";

  const goal =
    run.goal.trim().toLowerCase() === "describe your goal here"
      ? "Untitled run"
      : run.goal;

  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-2.5 py-2 rounded-lg transition-all ${
        active
          ? "bg-surface-2"
          : "hover:bg-surface-2/50"
      }`}
    >
      <div className="flex items-center gap-1.5 mb-1">
        <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusColor}`} />
        <span className="text-[10px] font-mono text-text-muted truncate">
          {run.id.slice(0, 8)}
        </span>
        <span className="text-[10px] text-text-muted/50 ml-auto shrink-0">
          {relativeTime(run.updated_at)}
        </span>
      </div>

      <div
        className={`text-[11px] leading-snug truncate ${active ? "text-text-primary" : "text-text-secondary"}`}
      >
        {goal.length > 55 ? goal.slice(0, 52) + "..." : goal}
      </div>

      {total > 0 && (
        <div className="flex items-center gap-2 mt-1.5">
          <div className="flex-1 h-[3px] bg-surface-3 rounded-full overflow-hidden">
            <div
              className="h-full bg-success/70 rounded-full transition-all duration-500"
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="text-[9px] text-text-muted tabular-nums shrink-0">
            {done}/{total}
          </span>
        </div>
      )}
    </button>
  );
}
