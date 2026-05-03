import React, { useState, useRef, useCallback } from "react";
import { Send, Loader2 } from "lucide-react";
import type { SwarmConfig } from "../types";

interface PromptProps {
  busy: boolean;
  onSubmit: (goal?: string) => void;
  config: SwarmConfig | null;
}

export function Prompt({ busy, onSubmit, config }: PromptProps) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const handleSubmit = useCallback(() => {
    const goal = value.trim();
    if (!goal || busy) return;
    onSubmit(goal);
    setValue("");
  }, [value, busy, onSubmit]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  return (
    <div className="border-t border-border bg-surface-1/40 px-3 sm:px-5 py-2.5">
      <div className="max-w-3xl mx-auto">
        <div className="relative">
          <textarea
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={busy ? "Working..." : "Create a plan from a goal"}
            disabled={busy}
            rows={1}
            className="w-full bg-surface-2/70 border border-border rounded-xl px-4 py-2.5 pr-11 text-[13px] text-text-primary placeholder:text-text-muted/70 focus:outline-none focus:border-accent/50 focus:bg-surface-2 transition-all resize-none disabled:opacity-40 font-sans"
            style={{ minHeight: "40px", maxHeight: "160px", height: "auto" }}
            onInput={(e) => {
              const target = e.target as HTMLTextAreaElement;
              target.style.height = "auto";
              target.style.height = `${Math.min(target.scrollHeight, 160)}px`;
            }}
          />
          <button
            onClick={handleSubmit}
            disabled={busy || !value.trim()}
            className="absolute right-1.5 bottom-1.5 p-1.5 rounded-lg bg-accent text-white hover:bg-accent/80 transition-all disabled:opacity-20 disabled:cursor-not-allowed"
          >
            {busy ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Send size={14} />
            )}
          </button>
        </div>

        <div className="flex items-center gap-3 mt-1.5 px-1 text-[10px] text-text-muted/60">
          <Kbd k="Enter" label="plan" />
          <Kbd k="Shift+Enter" label="newline" />
          <span className="hidden sm:inline text-text-muted/45">
            Plans first, workers only after review.
          </span>
          {config && (
            <span className="ml-auto tabular-nums">
              {config.parallelism}x · ${config.budget_usd}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function Kbd({ k, label }: { k: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <kbd className="px-1 py-px rounded bg-surface-3/80 text-text-muted text-[9px] font-mono leading-none">
        {k}
      </kbd>
      <span>{label}</span>
    </span>
  );
}
