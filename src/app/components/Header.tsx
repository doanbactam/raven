import React from "react";
import {
  FolderOpen,
  RefreshCw,
  Stethoscope,
  Settings,
  LayoutDashboard,
  Loader2,
} from "lucide-react";
import type { DoctorCheck } from "../types";
import type { View } from "../App";

interface HeaderProps {
  rootDir: string;
  busy: boolean;
  doctor: DoctorCheck[];
  onSelectProject: () => void;
  onRefresh: () => void;
  view: View;
  onViewChange: (v: View) => void;
}

export function Header({
  rootDir,
  busy,
  doctor,
  onSelectProject,
  onRefresh,
  view,
  onViewChange,
}: HeaderProps) {
  const failCount = doctor.filter((c) => c.level === "fail").length;
  const warnCount = doctor.filter((c) => c.level === "warn").length;
  const healthColor =
    failCount > 0 ? "text-danger" : warnCount > 0 ? "text-warning" : "text-success";
  const healthDot =
    failCount > 0 ? "bg-danger" : warnCount > 0 ? "bg-warning" : "bg-success";

  return (
    <div className="titlebar-drag flex items-center gap-2.5 px-4 h-11 border-b border-border glass shrink-0 relative z-10">
      <div className="hidden sm:block w-[68px] shrink-0" />

      <div className="flex items-center gap-2 titlebar-no-drag">
        <div className={`w-1.5 h-1.5 rounded-full ${healthDot} ${busy ? "animate-pulse-dot" : ""}`} />
        <span className="font-semibold text-[13px] tracking-tight text-text-primary">
          swarm
        </span>
      </div>

      <div className="w-px h-3.5 bg-border/60" />

      <button
        onClick={onSelectProject}
        className="titlebar-no-drag hidden md:flex items-center gap-1.5 text-[11px] text-text-muted hover:text-text-secondary transition-colors truncate max-w-[280px]"
      >
        <FolderOpen size={11} className="shrink-0" />
        <span className="truncate font-mono">{rootDir || "select project"}</span>
      </button>

      <div className="flex-1" />

      <div className="titlebar-no-drag flex items-center gap-0.5 bg-surface-2/60 rounded-lg p-0.5">
        <NavTab
          active={view === "chat"}
          onClick={() => onViewChange("chat")}
          icon={<LayoutDashboard size={12} />}
          label="Runs"
        />
        <NavTab
          active={view === "doctor"}
          onClick={() => onViewChange("doctor")}
          icon={<Stethoscope size={12} />}
          label="Doctor"
          badge={failCount > 0 ? failCount : undefined}
        />
        <NavTab
          active={view === "settings"}
          onClick={() => onViewChange("settings")}
          icon={<Settings size={12} />}
          label="Config"
        />
      </div>

      <div className="titlebar-no-drag flex items-center gap-1.5 ml-1">
        <span className={`text-[10px] font-medium ${healthColor}`}>
          {failCount > 0
            ? `${failCount} fail`
            : warnCount > 0
              ? `${warnCount} warn`
              : "ok"}
        </span>
        <button
          onClick={onRefresh}
          disabled={busy}
          className="p-1 rounded-md hover:bg-surface-3 text-text-muted hover:text-text-secondary transition-all disabled:opacity-30"
        >
          {busy ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <RefreshCw size={12} />
          )}
        </button>
      </div>
    </div>
  );
}

function NavTab({
  active,
  onClick,
  icon,
  label,
  badge,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  badge?: number;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-all ${
        active
          ? "bg-surface-0/80 text-text-primary shadow-sm"
          : "text-text-muted hover:text-text-secondary"
      }`}
    >
      {icon}
      <span>{label}</span>
      {badge !== undefined && (
        <span className="ml-0.5 w-4 h-4 rounded-full text-[9px] bg-danger/80 text-white flex items-center justify-center leading-none">
          {badge}
        </span>
      )}
    </button>
  );
}
