// Two views of the same run.
//
// "Trajectory" is the readable summary: what the agent did, one line each.
// "Raw" is every protocol message in order, which is where an interception
// will be visible, because a refusal or a correction only exists as an
// outbound record.
//
// The summary is derived. The raw view is the evidence, and wins on any
// disagreement.

import { useState } from "react";
import { isOurs, isStreamingNoise, type TraceRecord, type TraceStep } from "./trace";
import type { AgentRun } from "./types";

const ICONS: Record<TraceStep["kind"], string> = {
  command: "›_",
  file: "◆",
  search: "⌕",
  thinking: "◌",
  reply: "▸",
  approval: "⏸",
  steer: "↩",
  problem: "!",
};

const LABELS: Record<TraceStep["kind"], string> = {
  command: "ran",
  file: "changed",
  search: "searched",
  thinking: "reasoned",
  reply: "replied",
  approval: "paused",
  steer: "intervened",
  problem: "error",
};

export interface TrajectoryProps {
  steps: TraceStep[];
  records: TraceRecord[];
  /** True while the run is still going. */
  live: boolean;
  /** Run status, so the empty state can explain itself. */
  status: string | null;
  findings: NonNullable<AgentRun["findings"]>;
  /**
   * How many values the server replaced with a fingerprint on the way out,
   * from the `x-redactions` response header. Zero when nothing was altered.
   */
  redactions: number;
}

export function Trajectory({
  steps,
  records,
  live,
  status,
  findings,
  redactions,
}: TrajectoryProps) {
  const [view, setView] = useState<"steps" | "raw">("steps");
  const [showNoise, setShowNoise] = useState(false);
  const [open, setOpen] = useState(true);

  if (status === null) return null;

  const visible = showNoise ? records : records.filter((record) => !isStreamingNoise(record));
  const hidden = records.length - visible.length;

  return (
    <section className="trajectory">
      <header className="trajectory-head">
        {/* Collapse rather than dismiss, so the panel can always be reopened
            without re-running anything. */}
        <button
          className="trajectory-collapse"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          title={open ? "Collapse" : "Expand"}
        >
          {open ? "▾" : "▸"}
        </button>

        <div className="trajectory-tabs">
          <button
            className={view === "steps" ? "tab tab-on" : "tab"}
            onClick={() => setView("steps")}
          >
            Trajectory
          </button>
          <button className={view === "raw" ? "tab tab-on" : "tab"} onClick={() => setView("raw")}>
            Raw
          </button>
        </div>

        <span className="trajectory-count">
          {view === "steps"
            ? `${steps.length} step${steps.length === 1 ? "" : "s"}${live ? " so far" : ""}`
            : `${records.length} record${records.length === 1 ? "" : "s"}`}
        </span>

        <RedactionNotice count={redactions} />
      </header>

      {open &&
        (view === "steps" ? (
          <>
            <FindingList findings={findings} />
            <StepList steps={steps} live={live} records={records.length} status={status} />
          </>
        ) : (
          <RawList
            records={visible}
            hidden={hidden}
            showNoise={showNoise}
            onToggleNoise={() => setShowNoise(!showNoise)}
          />
        ))}
    </section>
  );
}

/**
 * Says that what is displayed below is not byte-for-byte what the agent did.
 *
 * The wording is "values redacted", never "secrets found", and the difference
 * is not pedantry. The redactor is tuned for recall, so most of what it
 * replaces is precautionary — a long base64 run or a hex digest that is
 * probably harmless. Calling those "secrets" would report a breach on almost
 * every run and train everyone to ignore the number.
 */
function RedactionNotice({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span
      className="trajectory-redactions"
      title={
        "Credential-shaped values were replaced with a fingerprint before this " +
        "trace left the server. The recorded trace on disk is unchanged."
      }
    >
      {count} value{count === 1 ? "" : "s"} redacted
    </span>
  );
}

function FindingList({ findings }: { findings: NonNullable<AgentRun["findings"]> }) {
  if (findings.length === 0) return null;
  return (
    <aside className="security-findings" aria-label="Security findings">
      <strong>Security and intent findings</strong>
      {findings.map((finding, index) => (
        <div className={"security-finding finding-" + finding.severity} key={`${finding.check}:${finding.code}:${finding.seq}:${index}`}>
          <span>{finding.severity}</span>
          <div>
            <code>{finding.check}/{finding.code}</code>
            <p>{finding.message}</p>
            <small>Evidence: {finding.evidence.map((seq) => `#${seq}`).join(", ")}</small>
          </div>
        </div>
      ))}
    </aside>
  );
}

function StepList(props: {
  steps: TraceStep[];
  live: boolean;
  records: number;
  status: string;
}) {
  if (props.steps.length === 0) {
    return <p className="trajectory-empty">{emptyMessage(props.live, props.records, props.status)}</p>;
  }

  return (
    <ol className="trajectory-list">
      {props.steps.map((step) => (
        <li className={"trajectory-step kind-" + step.kind} key={step.seq}>
          <span className="step-icon" aria-hidden="true">
            {ICONS[step.kind]}
          </span>

          <div className="step-body">
            <div className="step-title-row">
              <span className="step-label">{LABELS[step.kind]}</span>
              <span className="step-title">{step.title}</span>
              {step.outcome !== null && (
                <span className={"step-outcome outcome-" + step.outcome}>{step.outcome}</span>
              )}
            </div>

            {step.detail !== null && step.detail.trim() !== "" && (
              <pre className="step-detail">{step.detail}</pre>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

function RawList(props: {
  records: TraceRecord[];
  hidden: number;
  showNoise: boolean;
  onToggleNoise: () => void;
}) {
  if (props.records.length === 0) {
    return <p className="trajectory-empty">Nothing recorded yet.</p>;
  }

  return (
    <>
      {props.hidden > 0 && (
        <button className="raw-toggle" onClick={props.onToggleNoise}>
          {props.showNoise
            ? "Hide streaming deltas"
            : `Show ${props.hidden} hidden streaming delta${props.hidden === 1 ? "" : "s"}`}
        </button>
      )}

      <ol className="raw-list">
        {props.records.map((record) => (
          <RawRow key={record.seq} record={record} />
        ))}
      </ol>
    </>
  );
}

function RawRow({ record }: { record: TraceRecord }) {
  const [open, setOpen] = useState(false);
  const ours = isOurs(record);

  return (
    <li className={ours ? "raw-row raw-ours" : "raw-row"}>
      <button className="raw-summary" onClick={() => setOpen(!open)}>
        <span className="raw-seq">{record.seq}</span>
        {/* Outbound records are the only place our own actions appear, so they
            are marked. Any future refusal or correction shows up here. */}
        <span className="raw-dir">{ours ? "us →" : "← agent"}</span>
        <span className="raw-method">{record.method ?? "(response)"}</span>
      </button>

      {open && <pre className="raw-payload">{JSON.stringify(record.payload, null, 2)}</pre>}
    </li>
  );
}

/**
 * An empty trajectory is normal in three quite different situations, and saying
 * which one it is saves a lot of confusion.
 */
function emptyMessage(live: boolean, records: number, status: string): string {
  if (live && records === 0) return "Starting the Runtime container…";
  if (live) return "Connected to the agent. Waiting for its first action…";
  if (status === "failed") {
    return (
      "The run failed before the agent did anything. The trace holds the " +
      "handshake we sent, but the agent never got as far as acting."
    );
  }
  return "This run finished without taking any action.";
}
