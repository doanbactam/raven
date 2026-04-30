export interface SwarmAPI {
  overview: () => Promise<OverviewResult>;
  runDetail: (runId: string) => Promise<RunDetailResult>;
  initProject: () => Promise<{ ok: boolean; created?: string[]; skipped?: string[]; error?: string }>;
  saveConfig: (patch: Record<string, unknown>) => Promise<{ ok: boolean; config?: SwarmConfig; error?: string }>;
  plan: (goal?: string) => Promise<{ ok: boolean; runId?: string; taskCount?: number; costUsd?: number; error?: string }>;
  executeRun: (runId: string, resumed: boolean) => Promise<{ ok: boolean; error?: string }>;
}

export interface SwarmConfig {
  version: string;
  goal: string;
  parallelism: number;
  budget_usd: number;
  planner: string;
  worker: string;
  quality_gate: string;
  policies: Record<string, string | boolean>;
  routing: Record<string, string>;
}

export interface DoctorCheck {
  name: string;
  level: "ok" | "warn" | "fail";
  message: string;
}

export interface RunSummary {
  id: string;
  goal: string;
  status: string;
  created_at: string;
  updated_at: string;
  taskCount: number;
  counts: Record<string, number>;
}

export interface TaskSummary {
  id: string;
  status: string;
  summary: string;
  owned_files: string[];
  risk_level: "low" | "medium" | "high";
}

export interface SwarmEvent {
  run_id: string;
  task_id?: string;
  type: string;
  ts: string;
  payload: Record<string, unknown>;
}

export interface OverviewResult {
  ok: boolean;
  rootDir?: string;
  hasConfig?: boolean;
  config?: SwarmConfig | null;
  doctor?: DoctorCheck[];
  runs?: RunSummary[];
  error?: string;
}

export interface RunDetailResult {
  ok: boolean;
  run?: RunSummary;
  tasks?: TaskSummary[];
  events?: SwarmEvent[];
  costUsd?: number;
  error?: string;
}

