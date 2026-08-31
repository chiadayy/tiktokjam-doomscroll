import { useMemo, useState } from "react";
import type { AdminOverview, Agent } from "./types";

type Tab = "overview" | "interventions" | "patterns";

const labels: Record<string, string> = {
  data_exfiltration: "Data exfiltration",
  security_weakening: "Security weakening",
  scope_expansion: "Scope expansion",
  destructive_divergence: "Destructive divergence",
  persistence: "Persistence",
  oversight_evasion: "Oversight evasion",
  deception: "Deception",
  untrusted_instruction_adoption: "Untrusted instruction adoption",
  runtime_failure: "Runtime enforcement failure",
  timed_out: "Timed out",
};

function label(value: string): string {
  return labels[value] ?? value.replaceAll("_", " ");
}

export function Admin({ overview, agents, agentId, onSelectAgent, onReturnToChat, onViewRun }: {
  overview: AdminOverview | null;
  agents: Agent[];
  /** A selected agent switches the same live report into its operational view. */
  agentId: string | null;
  onSelectAgent: (agentId: string | null) => void;
  onReturnToChat: (agentId: string) => void;
  onViewRun: (agentId: string, runId: string) => void;
}) {
  const [tab, setTab] = useState<Tab>("overview");
  if (overview === null) {
    return <section className="admin-page"><p className="muted-copy">Loading operational evidence…</p></section>;
  }

  const agent = agentId === null ? null : agents.find((item) => item.id === agentId) ?? null;
  if (agent !== null) {
    return <AgentSafety overview={overview} agent={agent} onBack={() => onReturnToChat(agent.id)} onViewRun={onViewRun} />;
  }

  return (
    <section className="admin-page">
      <header className="admin-header">
        <div>
          <span className="eyebrow">Operator view</span>
          <h1>Admin</h1>
          <p>Read-only visibility across recorded runs, interventions, and learned safety memory.</p>
        </div>
      </header>
      <div className="admin-tabs" role="tablist" aria-label="Admin views">
        {(["overview", "interventions", "patterns"] as Tab[]).map((item) => (
          <button key={item} className={tab === item ? "selected" : ""} onClick={() => setTab(item)}>
            {item === "patterns" ? "Learned patterns" : label(item)}
          </button>
        ))}
      </div>

      {tab === "overview" && <Overview overview={overview} agents={agents} onSelectAgent={onSelectAgent} />}
      {tab === "interventions" && <Interventions overview={overview} onViewRun={onViewRun} />}
      {tab === "patterns" && <Patterns overview={overview} />}
    </section>
  );
}

function Overview({ overview, agents, onSelectAgent }: {
  overview: AdminOverview;
  agents: Agent[];
  onSelectAgent: (agentId: string) => void;
}) {
  const metrics = [
    ["Runs", overview.totals.runs], ["Intervened runs", overview.totals.intervenedRuns],
    ["Blocked actions", overview.totals.blockedActions], ["Redirects", overview.totals.redirects],
    ["Approval requests", overview.totals.approvalRequests], ["Approvals", overview.totals.approvals],
    ["Denied or timed out", overview.totals.denials + overview.totals.timeouts],
    ["Needs attention", overview.totals.needsAttention],
  ];
  return <>
    <dl className="admin-metrics">
      {metrics.map(([name, value]) => <div key={String(name)}><dt>{name}</dt><dd>{value}</dd></div>)}
    </dl>
    <section className="admin-section">
      <h2>Intervention categories</h2>
      {overview.categories.length === 0 ? <p className="muted-copy">No categorized interventions have been recorded.</p> : (
        <ul className="category-list">{overview.categories.map(({ category, count }) => (
          <li key={category}><span>{label(category)}</span><strong>{count}</strong></li>
        ))}</ul>
      )}
    </section>
    <section className="admin-section admin-agent-summary">
      <div className="section-heading">
        <div><h2>Agent safety</h2><p className="muted-copy">Open an agent to see only its interventions, approvals, and learned memory.</p></div>
      </div>
      {agents.length === 0 ? <p className="muted-copy">No agents have been created.</p> : (
        <div className="agent-safety-list">{agents.map((agent) => {
          const interventionCount = overview.interventions.filter((event) => event.agentId === agent.id).length;
          const patternCount = overview.learnedPatterns.filter((pattern) => pattern.agentId === agent.id).length;
          return <button className="agent-safety-row" key={agent.id} onClick={() => onSelectAgent(agent.id)}>
            <span><strong>{agent.name}</strong><small>{agent.description || "Coding Agent"}</small></span>
            <span className="agent-safety-counts"><small>{interventionCount} interventions · {patternCount} patterns</small><b>View safety →</b></span>
          </button>;
        })}</div>
      )}
    </section>
  </>;
}

function AgentSafety({ overview, agent, onBack, onViewRun }: {
  overview: AdminOverview;
  agent: Agent;
  onBack: () => void;
  onViewRun: (agentId: string, runId: string) => void;
}) {
  return <section className="admin-page">
    <button className="back-link" onClick={onBack}>← Back to {agent.name}</button>
    <header className="admin-header">
      <div><span className="eyebrow">Agent safety</span><h1>{agent.name}</h1><p>Operational takeaways for this agent only. Fleet-wide trends remain in Fleet safety.</p></div>
    </header>
    <AgentSafetyDetails overview={overview} agent={agent} onViewRun={onViewRun} />
  </section>;
}

/** Live, agent-scoped safety evidence. Reused in the chat-side safety panel. */
export function AgentSafetyDetails({ overview, agent, onViewRun }: {
  overview: AdminOverview;
  agent: Agent;
  onViewRun: (agentId: string, runId: string) => void;
}) {
  const data = useMemo(() => {
    const interventions = overview.interventions.filter((event) => event.agentId === agent.id);
    const patterns = overview.learnedPatterns.filter((pattern) => pattern.agentId === agent.id);
    const human = interventions.filter((event) => event.layer === "human");
    const categories = new Map<string, number>();
    for (const event of interventions) {
      if (event.category !== null) categories.set(event.category, (categories.get(event.category) ?? 0) + 1);
    }
    return {
      interventions,
      patterns,
      categories: [...categories.entries()].map(([category, count]) => ({ category, count })),
      blocked: interventions.filter((event) => event.outcome === "blocked").length,
      redirected: interventions.filter((event) => event.outcome === "redirected").length,
      approvals: human.filter((event) => event.outcome === "approved").length,
      denied: human.filter((event) => event.outcome === "denied" || event.outcome === "timed_out").length,
    };
  }, [agent.id, overview]);
  const metrics = [["Interventions", data.interventions.length], ["Blocked", data.blocked], ["Redirected", data.redirected], ["Approved actions", data.approvals], ["Denied or timed out", data.denied], ["Learned patterns", data.patterns.length]];

  return <>
    <dl className="admin-metrics agent-metrics">{metrics.map(([name, value]) => <div key={String(name)}><dt>{name}</dt><dd>{value}</dd></div>)}</dl>
    <section className="admin-section">
      <h2>What this agent needed help with</h2>
      {data.categories.length === 0 ? <p className="muted-copy">No categorized interventions have been recorded for this agent.</p> : <ul className="category-list">{data.categories.map(({ category, count }) => <li key={category}><span>{label(category)}</span><strong>{count}</strong></li>)}</ul>}
    </section>
    <section className="admin-section">
      <h2>Intervention history</h2>
      {data.interventions.length === 0 ? <p className="muted-copy">No interventions have been recorded for this agent.</p> : <InterventionList interventions={data.interventions} onViewRun={onViewRun} />}
    </section>
    <section className="admin-section">
      <h2>Learned safety memory</h2>
      <p className="muted-copy">These are warn-and-steer signals only; they cannot approve or block an action.</p>
      {data.patterns.length === 0 ? <p className="muted-copy">No learned patterns have been recorded for this agent.</p> : <PatternList patterns={data.patterns} />}
    </section>
  </>;
}

function Interventions({ overview, onViewRun }: { overview: AdminOverview; onViewRun: (agentId: string, runId: string) => void }) {
  return <section className="admin-section">
    <h2>Interventions</h2>
    {overview.interventions.length === 0 ? <p className="muted-copy">No interventions have been recorded.</p> : (
      <InterventionList interventions={overview.interventions} onViewRun={onViewRun} />
    )}
  </section>;
}

function InterventionList({ interventions, onViewRun }: { interventions: AdminOverview["interventions"]; onViewRun: (agentId: string, runId: string) => void }) {
  return <div className="intervention-list">{interventions.map((event) => (
        <article className="intervention" key={event.id}>
          <div><strong>{event.agentName}</strong><span>{new Date(event.at).toLocaleString()}</span></div>
          <p>{event.summary}</p>
          <footer><span className="event-tag">{label(event.layer)}</span><span className="event-tag">{label(event.outcome)}</span>{event.category && <span className="event-tag">{label(event.category)}</span>}<button onClick={() => onViewRun(event.agentId, event.runId)}>View run</button></footer>
        </article>
      ))}</div>;
}

function Patterns({ overview }: { overview: AdminOverview }) {
  return <section className="admin-section">
    <h2>Learned patterns</h2>
    <p className="muted-copy">These are warn-and-steer signals only; they cannot approve or block an action.</p>
    {overview.learnedPatterns.length === 0 ? <p className="muted-copy">No learned patterns have been recorded.</p> : (
      <PatternList patterns={overview.learnedPatterns} />
    )}
  </section>;
}

function PatternList({ patterns }: { patterns: AdminOverview["learnedPatterns"] }) {
  return <div className="pattern-list">{patterns.map((pattern, index) => (
        <article className="pattern" key={`${pattern.agentId}:${pattern.value}:${index}`}>
          <div><strong>{pattern.value}</strong><span>{pattern.agentName} · {pattern.subjectType}{pattern.derivedFamily ? " · derived family" : ""}</span></div>
          <p>Precondition: {pattern.precondition}{pattern.channel ? ` · Channel: ${pattern.channel}` : ""}</p>
          <p className="muted-copy">{pattern.effect}</p>
          <footer><span>{pattern.sightings} sightings{pattern.conversations !== null ? ` · ${pattern.conversations} conversations` : ""}</span>{pattern.recurring && <span className="event-tag">Recurring</span>}{pattern.needsAttention && <span className="event-tag">Needs attention</span>}</footer>
        </article>
      ))}</div>;
}
