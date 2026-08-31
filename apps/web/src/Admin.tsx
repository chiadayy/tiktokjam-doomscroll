import { useState } from "react";
import type { AdminOverview } from "./types";

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

export function Admin({ overview, onViewRun }: {
  overview: AdminOverview | null;
  onViewRun: (agentId: string, runId: string) => void;
}) {
  const [tab, setTab] = useState<Tab>("overview");
  if (overview === null) {
    return <section className="admin-page"><p className="muted-copy">Loading operational evidence…</p></section>;
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

      {tab === "overview" && <Overview overview={overview} />}
      {tab === "interventions" && <Interventions overview={overview} onViewRun={onViewRun} />}
      {tab === "patterns" && <Patterns overview={overview} />}
    </section>
  );
}

function Overview({ overview }: { overview: AdminOverview }) {
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
  </>;
}

function Interventions({ overview, onViewRun }: { overview: AdminOverview; onViewRun: (agentId: string, runId: string) => void }) {
  return <section className="admin-section">
    <h2>Interventions</h2>
    {overview.interventions.length === 0 ? <p className="muted-copy">No interventions have been recorded.</p> : (
      <div className="intervention-list">{overview.interventions.map((event) => (
        <article className="intervention" key={event.id}>
          <div><strong>{event.agentName}</strong><span>{new Date(event.at).toLocaleString()}</span></div>
          <p>{event.summary}</p>
          <footer><span className="event-tag">{label(event.layer)}</span><span className="event-tag">{label(event.outcome)}</span>{event.category && <span className="event-tag">{label(event.category)}</span>}<button onClick={() => onViewRun(event.agentId, event.runId)}>View run</button></footer>
        </article>
      ))}</div>
    )}
  </section>;
}

function Patterns({ overview }: { overview: AdminOverview }) {
  return <section className="admin-section">
    <h2>Learned patterns</h2>
    <p className="muted-copy">These are warn-and-steer signals only; they cannot approve or block an action.</p>
    {overview.learnedPatterns.length === 0 ? <p className="muted-copy">No learned patterns have been recorded.</p> : (
      <div className="pattern-list">{overview.learnedPatterns.map((pattern, index) => (
        <article className="pattern" key={`${pattern.agentId}:${pattern.value}:${index}`}>
          <div><strong>{pattern.value}</strong><span>{pattern.agentName} · {pattern.subjectType}{pattern.derivedFamily ? " · derived family" : ""}</span></div>
          <p>Precondition: {pattern.precondition}{pattern.channel ? ` · Channel: ${pattern.channel}` : ""}</p>
          <p className="muted-copy">{pattern.effect}</p>
          <footer><span>{pattern.sightings} sightings{pattern.conversations !== null ? ` · ${pattern.conversations} conversations` : ""}</span>{pattern.recurring && <span className="event-tag">Recurring</span>}{pattern.needsAttention && <span className="event-tag">Needs attention</span>}</footer>
        </article>
      ))}</div>
    )}
  </section>;
}
