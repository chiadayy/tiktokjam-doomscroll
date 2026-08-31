import { paramsFrom, tierOf, type Reflection } from "./reflections.js";
import { reportingCategoryForFinding, type RemediationCategory } from "./steering-policy.js";
import type { Finding } from "./checks.js";
import type { Agent, AgentRun } from "./types.js";

export interface AdminOverview {
  totals: {
    runs: number;
    intervenedRuns: number;
    blockedActions: number;
    redirects: number;
    approvalRequests: number;
    approvals: number;
    denials: number;
    timeouts: number;
    recurringPatterns: number;
    needsAttention: number;
  };
  categories: Array<{ category: RemediationCategory; count: number }>;
  interventions: AdminIntervention[];
  learnedPatterns: AdminLearnedPattern[];
}

export interface AdminIntervention {
  id: string;
  at: string;
  runId: string;
  agentId: string;
  agentName: string;
  category: RemediationCategory | null;
  layer: "deterministic" | "semantic" | "memory" | "runtime" | "human";
  outcome: "blocked" | "redirected" | "warning" | "runtime_failure" | "approved" | "denied" | "timed_out";
  summary: string;
}

export interface AdminLearnedPattern {
  agentId: string;
  agentName: string;
  subjectType: "destination" | "file" | "pattern";
  value: string;
  precondition: string;
  channel: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  sightings: number;
  conversations: number | null;
  recurring: boolean;
  needsAttention: boolean;
  derivedFamily: boolean;
  effect: string;
}

const CATEGORY_ORDER: RemediationCategory[] = [
  "data_exfiltration", "security_weakening", "scope_expansion", "destructive_divergence",
  "persistence", "oversight_evasion", "deception", "untrusted_instruction_adoption",
];

export function buildAdminOverview(agents: Agent[], runs: AgentRun[]): AdminOverview {
  const byAgent = new Map(agents.map((agent) => [agent.id, agent]));
  const categories = new Map<RemediationCategory, number>();
  const interventions: AdminIntervention[] = [];
  let blockedActions = 0;
  let redirects = 0;
  let approvalRequests = 0;
  let approvals = 0;
  let denials = 0;
  let timeouts = 0;

  for (const run of runs) {
    const agent = byAgent.get(run.agentId);
    for (const finding of run.findings ?? []) {
      const category = reportingCategoryForFinding(finding);
      if (category !== null) categories.set(category, (categories.get(category) ?? 0) + 1);
      const event = interventionFor(run, agent, finding, category);
      if (event === null) continue;
      interventions.push(event);
      if (event.outcome === "blocked") blockedActions += 1;
      if (event.outcome === "redirected") redirects += 1;
      if (finding.check === "human-approval") {
        const outcome = finding.metadata?.outcome;
        if (outcome === "requested") approvalRequests += 1;
        if (outcome === "approved") approvals += 1;
        if (outcome === "denied") denials += 1;
        if (outcome === "timed_out") timeouts += 1;
      }
    }
  }

  const learnedPatterns = agents.flatMap(patternsForAgent);
  return {
    totals: {
      runs: runs.length,
      intervenedRuns: runs.filter((run) => run.intervened === true).length,
      blockedActions,
      redirects,
      approvalRequests,
      approvals,
      denials,
      timeouts,
      recurringPatterns: learnedPatterns.filter((pattern) => pattern.recurring).length,
      needsAttention: learnedPatterns.filter((pattern) => pattern.needsAttention).length,
    },
    categories: CATEGORY_ORDER.flatMap((category) => {
      const count = categories.get(category) ?? 0;
      return count === 0 ? [] : [{ category, count }];
    }),
    interventions: interventions.sort((left, right) => right.at.localeCompare(left.at)).slice(0, 100),
    learnedPatterns,
  };
}

function interventionFor(
  run: AgentRun,
  agent: Agent | undefined,
  finding: Finding,
  category: RemediationCategory | null,
): AdminIntervention | null {
  const base = {
    id: `${run.id}:${finding.check}:${finding.code}:${finding.seq}`,
    at: run.completedAt ?? run.createdAt,
    runId: run.id,
    agentId: run.agentId,
    agentName: agent?.name ?? "Unknown Agent",
    category,
    summary: bounded(finding.message),
  };
  if (finding.check === "human-approval") {
    const outcome = finding.metadata?.outcome;
    if (outcome === "requested") return { ...base, layer: "human", outcome: "warning" };
    if (outcome === "approved") return { ...base, layer: "human", outcome: "approved" };
    return { ...base, layer: "human", outcome: outcome === "timed_out" ? "timed_out" : "denied" };
  }
  if (finding.check === "runtime-enforcement" || finding.check === "semantic-enforcement") {
    return { ...base, layer: "runtime", outcome: "runtime_failure" };
  }
  if (finding.check === "learned-watch") return { ...base, layer: "memory", outcome: "redirected" };
  if (finding.check === "semantic-intent") {
    const decision = finding.metadata?.controllerDecision;
    if (decision === "steer") return { ...base, layer: "semantic", outcome: "redirected" };
    if (decision === "decline") return { ...base, layer: "semantic", outcome: "blocked" };
    return null;
  }
  if (finding.severity === "violation") return { ...base, layer: "deterministic", outcome: "blocked" };
  if (finding.severity === "warn" && finding.requestSteer === true) {
    return { ...base, layer: "deterministic", outcome: "redirected" };
  }
  return null;
}

function patternsForAgent(agent: Agent): AdminLearnedPattern[] {
  const exact = (agent.reflections ?? []).map((reflection) => pattern(agent, reflection));
  const families = paramsFrom(agent.reflections ?? []).watchedDestinations
    .filter((entry) => entry.family)
    .map((entry) => ({
      agentId: agent.id, agentName: agent.name, subjectType: "destination" as const,
      value: `*.${entry.value}`, precondition: entry.precondition, channel: null,
      firstSeenAt: "", lastSeenAt: "", sightings: 0, conversations: null,
      recurring: entry.tier === "recurring", needsAttention: false, derivedFamily: true,
      effect: "Future contact under this family triggers a warning and steering only.",
    }));
  return [...exact, ...families];
}

function pattern(agent: Agent, reflection: Reflection): AdminLearnedPattern {
  const destination = reflection.facts.destination;
  const source = reflection.facts.source;
  const conversations = reflection.threads?.length ?? null;
  return {
    agentId: agent.id, agentName: agent.name,
    subjectType: destination !== undefined ? "destination" : source !== undefined ? "file" : "pattern",
    value: destination ?? source ?? reflection.code,
    precondition: reflection.facts.precondition ?? "none",
    channel: reflection.facts.channel ?? null,
    firstSeenAt: reflection.firstSeenAt, lastSeenAt: reflection.lastSeenAt,
    sightings: reflection.sightings.length, conversations,
    recurring: tierOf(reflection) === "recurring",
    needsAttention: conversations !== null && conversations >= 3,
    derivedFamily: false,
    effect: "Future matches trigger warning and steering only. They cannot block actions.",
  };
}

function bounded(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 360);
}
