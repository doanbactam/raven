import React from "react";
import type { RunSummary } from "../types";

interface StatusBarProps {
  busy: boolean;
  message: string;
  run: RunSummary | null;
  costUsd: number;
}

export function StatusBar({ busy, message, run, costUsd }: StatusBarProps) {
  const done = run?.counts.done ?? 0;
  const total = run?.taskCount ?? 0;

  return (
    <div className="flex items-center justify-between px-4 h-6 border-t border-border bg-surface-0 text-[10px] shrink-0 font-mono">
      <div className={`truncate flex items-center gap-1.5 ${busy ? "text-accent" : "text-text-muted/70"}`}>
        {busy && (
          <span className="inline-block w-1 h-1 rounded-full bg-accent animate-pulse-dot" />
        )}
        <span>{message}</span>
      </div>

      <div className="flex items-center gap-2 text-text-muted/50 shrink-0">
        {run && (
          <>
            <span className={run.status === "failed" ? "text-danger/70" : ""}>{run.status}</span>
            <span className="text-border/40">|</span>
            <span className="tabular-nums">{done}/{total}</span>
          </>
        )}
        <span className="text-border/40">|</span>
        <span className="tabular-nums">${costUsd.toFixed(4)}</span>
      </div>
    </div>
  );
}
