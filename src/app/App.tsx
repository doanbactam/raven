import React, { useState } from "react";
import { useSwarm } from "./hooks/useSwarm";
import { Header } from "./components/Header";
import { Sidebar } from "./components/Sidebar";
import { ChatArea } from "./components/ChatArea";
import { Prompt } from "./components/Prompt";
import { StatusBar } from "./components/StatusBar";

export type View = "chat" | "doctor" | "settings";

export function App() {
  const swarm = useSwarm();
  const [view, setView] = useState<View>("chat");
  const isConnecting =
    swarm.state.message === "Loading..." || swarm.state.message === "Refreshing...";
  const hasError =
    swarm.state.message.startsWith("API ") ||
    swarm.state.message.includes("fetch") ||
    swarm.state.message.includes("Failed to") ||
    swarm.state.message.includes("NetworkError");

  if (isConnecting && swarm.state.runs.length === 0 && !swarm.state.rootDir) {
    return <LoadingScreen />;
  }

  if (hasError && swarm.state.runs.length === 0 && !swarm.state.rootDir) {
    return <ConnectionError message={swarm.state.message} onRetry={swarm.refresh} />;
  }

  return (
    <div className="h-screen flex flex-col bg-surface-0 text-text-primary overflow-hidden font-sans relative noise">
      <Header
        rootDir={swarm.state.rootDir}
        busy={swarm.state.busy}
        doctor={swarm.state.doctor}
        onSelectProject={() => {}}
        onRefresh={swarm.refresh}
        view={view}
        onViewChange={setView}
      />

      <div className="flex flex-1 min-h-0">
        <Sidebar
          runs={swarm.state.runs}
          selectedRunId={swarm.state.selectedRunId}
          onSelectRun={swarm.selectRun}
          busy={swarm.state.busy}
        />

        <div className="flex-1 flex flex-col min-w-0">
          <ChatArea
            view={view}
            run={swarm.state.selectedRun}
            tasks={swarm.state.tasks}
            events={swarm.state.events}
            costUsd={swarm.state.costUsd}
            doctor={swarm.state.doctor}
            config={swarm.state.config}
            busy={swarm.state.busy}
            hasConfig={swarm.state.hasConfig}
            onInit={swarm.initProject}
            onRun={(runId: string) => swarm.executeRun(runId, false)}
            onResume={(runId: string) => swarm.executeRun(runId, true)}
            onSaveConfig={swarm.saveConfig}
          />

          <Prompt
            busy={swarm.state.busy}
            onSubmit={swarm.plan}
            config={swarm.state.config}
          />
        </div>
      </div>

      <StatusBar
        busy={swarm.state.busy}
        message={swarm.state.message}
        run={swarm.state.selectedRun}
        costUsd={swarm.state.costUsd}
      />
    </div>
  );
}

function LoadingScreen() {
  return (
    <div className="h-screen flex flex-col items-center justify-center bg-surface-0 font-sans">
      <div className="flex items-center gap-3 mb-6">
        <div className="w-2 h-2 rounded-full bg-accent animate-pulse-dot" />
        <span className="text-sm text-text-secondary tracking-wide">
          Connecting to backend...
        </span>
      </div>
      <div className="w-64 space-y-3">
        <div className="skeleton h-3 w-full" />
        <div className="skeleton h-3 w-3/4" />
        <div className="skeleton h-3 w-1/2" />
      </div>
    </div>
  );
}

function ConnectionError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="h-screen flex flex-col items-center justify-center bg-surface-0 font-sans">
      <div className="w-10 h-10 rounded-xl bg-danger-soft flex items-center justify-center mb-4">
        <span className="text-danger text-lg">!</span>
      </div>
      <h2 className="text-base font-semibold text-text-primary mb-1">
        Cannot reach API server
      </h2>
      <p className="text-xs text-text-secondary mb-1 max-w-sm text-center">
        Start the backend with <code className="text-accent font-mono text-[11px]">npm run ui</code> or <code className="text-accent font-mono text-[11px]">npm run dev:web</code>
      </p>
      <p className="text-[11px] text-text-muted font-mono mb-4 max-w-md truncate">
        {message}
      </p>
      <button
        onClick={onRetry}
        className="px-4 py-1.5 rounded-lg bg-surface-2 border border-border text-xs text-text-secondary hover:text-text-primary hover:border-border-active transition-all"
      >
        Retry
      </button>
    </div>
  );
}
