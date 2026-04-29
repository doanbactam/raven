import { runSuite, type EvalRunResult, modeSucceeded } from "./eval.js";

/**
 * Pilot report data structure. Aggregates eval results across suites
 * into a go/no-go decision format matching PLAN.md Phase 4 deliverable.
 */
export interface PilotReport {
  timestamp: string;
  suites: SuiteReport[];
  globalMetrics: GlobalMetrics;
  goNoGo: GoNoGoDecision;
}

export interface SuiteReport {
  name: string;
  results: EvalRunResult[];
  metrics: SuiteMetrics;
}

export interface SuiteMetrics {
  totalRuns: number;
  baselinePassRate: number;
  swarmPassRate: number;
  baselineAvgCost: number;
  swarmAvgCost: number;
  baselineAvgWallMs: number;
  swarmAvgWallMs: number;
  costRatio: number;
  qualityDelta: number;
  wallClockDelta: number;
}

export interface GlobalMetrics {
  totalInstances: number;
  baselinePassRate: number;
  swarmPassRate: number;
  costRatio: number;
  qualityUplift: number;
  wallClockDelta: number;
}

export interface GoNoGoDecision {
  verdict: "GO" | "NO-GO" | "CONDITIONAL";
  reasons: string[];
  blockers: string[];
  recommendations: string[];
}

/**
 * Run the pilot evaluation: executes the suite, computes metrics, and renders decision.
 */
export async function runPilot(
  suitePath: string,
  opts: { swarmCli: string; claudeBin?: string | undefined },
): Promise<PilotReport> {
  const suiteOpts: { swarmCli: string; claudeBin?: string } = { swarmCli: opts.swarmCli };
  if (opts.claudeBin) suiteOpts.claudeBin = opts.claudeBin;
  const results = await runSuite(suitePath, suiteOpts);

  const suiteName = suitePath.replace(/^.*[\\/]/, "").replace(/\.(yaml|yml)$/, "");
  const suiteMetrics = computeSuiteMetrics(results);
  const suiteReport: SuiteReport = { name: suiteName, results, metrics: suiteMetrics };

  const globalMetrics = computeGlobalMetrics([suiteReport]);
  const goNoGo = computeGoNoGo(globalMetrics);

  return {
    timestamp: new Date().toISOString(),
    suites: [suiteReport],
    globalMetrics,
    goNoGo,
  };
}

function computeSuiteMetrics(results: EvalRunResult[]): SuiteMetrics {
  const baseline = results.filter((r) => r.mode === "baseline");
  const swarm = results.filter((r) => r.mode === "swarm");

  const baselinePass = baseline.filter((r) => modeSucceeded(r) && (r.verifyExit === 0 || r.verifyExit === -1));
  const swarmPass = swarm.filter((r) => modeSucceeded(r) && (r.verifyExit === 0 || r.verifyExit === -1));

  const baselinePassRate = baseline.length > 0 ? baselinePass.length / baseline.length : 0;
  const swarmPassRate = swarm.length > 0 ? swarmPass.length / swarm.length : 0;

  const baselineAvgCost = baseline.length > 0
    ? baseline.reduce((a, r) => a + r.costUsd, 0) / baseline.length : 0;
  const swarmAvgCost = swarm.length > 0
    ? swarm.reduce((a, r) => a + r.costUsd, 0) / swarm.length : 0;

  const baselineAvgWallMs = baseline.length > 0
    ? baseline.reduce((a, r) => a + r.wallMs, 0) / baseline.length : 0;
  const swarmAvgWallMs = swarm.length > 0
    ? swarm.reduce((a, r) => a + r.wallMs, 0) / swarm.length : 0;

  const costRatio = baselineAvgCost > 0 ? swarmAvgCost / baselineAvgCost : 0;
  const qualityDelta = swarmPassRate - baselinePassRate;
  const wallClockDelta = baselineAvgWallMs > 0
    ? (swarmAvgWallMs - baselineAvgWallMs) / baselineAvgWallMs : 0;

  return {
    totalRuns: results.length,
    baselinePassRate,
    swarmPassRate,
    baselineAvgCost,
    swarmAvgCost,
    baselineAvgWallMs,
    swarmAvgWallMs,
    costRatio,
    qualityDelta,
    wallClockDelta,
  };
}

function computeGlobalMetrics(suites: SuiteReport[]): GlobalMetrics {
  const allResults = suites.flatMap((s) => s.results);
  const baseline = allResults.filter((r) => r.mode === "baseline");
  const swarm = allResults.filter((r) => r.mode === "swarm");

  const baselinePass = baseline.filter((r) => modeSucceeded(r) && (r.verifyExit === 0 || r.verifyExit === -1));
  const swarmPass = swarm.filter((r) => modeSucceeded(r) && (r.verifyExit === 0 || r.verifyExit === -1));

  const baselinePassRate = baseline.length > 0 ? baselinePass.length / baseline.length : 0;
  const swarmPassRate = swarm.length > 0 ? swarmPass.length / swarm.length : 0;

  const baselineAvgCost = baseline.length > 0
    ? baseline.reduce((a, r) => a + r.costUsd, 0) / baseline.length : 0;
  const swarmAvgCost = swarm.length > 0
    ? swarm.reduce((a, r) => a + r.costUsd, 0) / swarm.length : 0;

  const baselineAvgWallMs = baseline.length > 0
    ? baseline.reduce((a, r) => a + r.wallMs, 0) / baseline.length : 0;
  const swarmAvgWallMs = swarm.length > 0
    ? swarm.reduce((a, r) => a + r.wallMs, 0) / swarm.length : 0;

  return {
    totalInstances: allResults.length,
    baselinePassRate,
    swarmPassRate,
    costRatio: baselineAvgCost > 0 ? swarmAvgCost / baselineAvgCost : 0,
    qualityUplift: swarmPassRate - baselinePassRate,
    wallClockDelta: baselineAvgWallMs > 0
      ? (swarmAvgWallMs - baselineAvgWallMs) / baselineAvgWallMs : 0,
  };
}

/**
 * Apply go/no-go criteria from PLAN.md section 3:
 * - Cost gap ≤2×
 * - Quality ≥10% better
 * - Wall-clock ±15%
 */
function computeGoNoGo(metrics: GlobalMetrics): GoNoGoDecision {
  const reasons: string[] = [];
  const blockers: string[] = [];
  const recommendations: string[] = [];

  // Cost ratio check: target ≤2×
  if (metrics.costRatio <= 2) {
    reasons.push(`Cost ratio ${metrics.costRatio.toFixed(2)}× meets ≤2× target`);
  } else {
    blockers.push(`Cost ratio ${metrics.costRatio.toFixed(2)}× exceeds 2× target`);
    recommendations.push("Investigate cost reduction: shared session prefix, model routing, prompt compression");
  }

  // Quality uplift check: target ≥10%
  if (metrics.qualityUplift >= 0.10) {
    reasons.push(`Quality uplift ${(metrics.qualityUplift * 100).toFixed(1)}% meets ≥10% target`);
  } else if (metrics.qualityUplift >= 0) {
    reasons.push(`Quality uplift ${(metrics.qualityUplift * 100).toFixed(1)}% — positive but below 10% target`);
    recommendations.push("Consider expanding task decomposition quality or adding more gate checks");
  } else {
    blockers.push(`Quality regression ${(metrics.qualityUplift * 100).toFixed(1)}% — swarm is worse than baseline`);
    recommendations.push("Investigate root cause: are tasks too fine-grained? Are merges losing work?");
  }

  // Wall-clock check: target ±15%
  if (Math.abs(metrics.wallClockDelta) <= 0.15) {
    reasons.push(`Wall-clock delta ${(metrics.wallClockDelta * 100).toFixed(1)}% within ±15%`);
  } else if (metrics.wallClockDelta < -0.15) {
    reasons.push(`Wall-clock ${(metrics.wallClockDelta * 100).toFixed(1)}% faster — bonus`);
  } else {
    blockers.push(`Wall-clock ${(metrics.wallClockDelta * 100).toFixed(1)}% slower — exceeds +15% threshold`);
    recommendations.push("Increase parallelism or reduce task granularity");
  }

  // Edge case: no data
  if (metrics.totalInstances === 0) {
    blockers.push("No evaluation data available");
    recommendations.push("Run the pilot suite before making go/no-go decision");
  }

  let verdict: "GO" | "NO-GO" | "CONDITIONAL";
  if (blockers.length === 0 && reasons.length > 0) {
    verdict = "GO";
  } else if (blockers.length >= 2) {
    verdict = "NO-GO";
  } else {
    verdict = "CONDITIONAL";
  }

  return { verdict, reasons, blockers, recommendations };
}

/**
 * Format the pilot report as Markdown suitable for PILOT_REPORT.md.
 */
export function formatPilotReport(report: PilotReport): string {
  const lines: string[] = [];
  lines.push("# PILOT REPORT");
  lines.push("");
  lines.push(`Generated: ${report.timestamp}`);
  lines.push("");

  // Decision
  lines.push("## Go / No-Go Decision");
  lines.push("");
  const emoji = report.goNoGo.verdict === "GO" ? "✅" : report.goNoGo.verdict === "NO-GO" ? "❌" : "⚠️";
  lines.push(`### ${emoji} Verdict: **${report.goNoGo.verdict}**`);
  lines.push("");

  if (report.goNoGo.reasons.length > 0) {
    lines.push("**Passing criteria:**");
    for (const r of report.goNoGo.reasons) lines.push(`- ${r}`);
    lines.push("");
  }
  if (report.goNoGo.blockers.length > 0) {
    lines.push("**Blockers:**");
    for (const b of report.goNoGo.blockers) lines.push(`- ❌ ${b}`);
    lines.push("");
  }
  if (report.goNoGo.recommendations.length > 0) {
    lines.push("**Recommendations:**");
    for (const r of report.goNoGo.recommendations) lines.push(`- ${r}`);
    lines.push("");
  }

  // Global metrics
  lines.push("## Global Metrics");
  lines.push("");
  lines.push("| Metric | Value | Target |");
  lines.push("|---|---|---|");
  lines.push(`| Total instances | ${report.globalMetrics.totalInstances} | — |`);
  lines.push(`| Baseline pass rate | ${(report.globalMetrics.baselinePassRate * 100).toFixed(1)}% | — |`);
  lines.push(`| Swarm pass rate | ${(report.globalMetrics.swarmPassRate * 100).toFixed(1)}% | — |`);
  lines.push(`| Quality uplift | ${(report.globalMetrics.qualityUplift * 100).toFixed(1)}% | ≥10% |`);
  lines.push(`| Cost ratio (swarm/baseline) | ${report.globalMetrics.costRatio.toFixed(2)}× | ≤2× |`);
  lines.push(`| Wall-clock delta | ${(report.globalMetrics.wallClockDelta * 100).toFixed(1)}% | ±15% |`);
  lines.push("");

  // Per-suite details
  for (const suite of report.suites) {
    lines.push(`## Suite: ${suite.name}`);
    lines.push("");
    lines.push(`- Runs: ${suite.metrics.totalRuns}`);
    lines.push(`- Baseline pass rate: ${(suite.metrics.baselinePassRate * 100).toFixed(1)}%`);
    lines.push(`- Swarm pass rate: ${(suite.metrics.swarmPassRate * 100).toFixed(1)}%`);
    lines.push(`- Baseline avg cost: $${suite.metrics.baselineAvgCost.toFixed(4)}`);
    lines.push(`- Swarm avg cost: $${suite.metrics.swarmAvgCost.toFixed(4)}`);
    lines.push(`- Cost ratio: ${suite.metrics.costRatio.toFixed(2)}×`);
    lines.push(`- Wall-clock delta: ${(suite.metrics.wallClockDelta * 100).toFixed(1)}%`);
    lines.push("");

    // Per-entry table
    lines.push("| Entry | Mode | Success | Verify | Cost | Wall (s) |");
    lines.push("|---|---|---|---|---|---|");
    for (const r of suite.results) {
      const success = modeSucceeded(r) ? "✅" : "❌";
      const verify = r.verifyExit === 0 ? "✅" : r.verifyExit === -1 ? "—" : "❌";
      lines.push(
        `| ${r.entryId} | ${r.mode} | ${success} | ${verify} | $${r.costUsd.toFixed(4)} | ${(r.wallMs / 1000).toFixed(1)} |`,
      );
    }
    lines.push("");
  }

  // Methodology
  lines.push("## Methodology");
  lines.push("");
  lines.push("- Each entry is run in an isolated temp directory copied from its fixture.");
  lines.push("- Baseline: single Claude agent with `--dangerously-skip-permissions`.");
  lines.push("- Swarm: `swarm init` → `swarm plan` → `swarm run` → `swarm merge`.");
  lines.push("- Verification: entry-specific `verify_cmd` executed post-run.");
  lines.push("- Cost: extracted from Claude CLI stream-json `total_cost_usd` field.");
  lines.push("- Go/No-Go criteria from PLAN.md section 3.");
  lines.push("");

  return lines.join("\n");
}
