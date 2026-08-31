// Two levels of the same run.
//
// "Agent activity" is the readable summary: what the agent did, one line each.
// "Technical details" keeps every finding and protocol record for audit.
//
// The summary is derived. The raw view is the evidence, and wins on any
// disagreement.

import { useEffect, useMemo, useState } from "react";
import { isOurs, isStreamingNoise, type TraceRecord, type TraceStep } from "./trace";
import type { AgentRun, Finding, HumanApprovalRequest } from "./types";

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
  pendingApproval?: HumanApprovalRequest | null;
  approvalBusy?: boolean;
  onApprovalDecision?: (decision: "approve" | "deny") => void;
}

export function Trajectory({
  steps,
  records,
  live,
  status,
  findings,
  redactions,
  pendingApproval = null,
  approvalBusy = false,
  onApprovalDecision,
}: TrajectoryProps) {
  const [view, setView] = useState<"activity" | "technical">("activity");
  const [showNoise, setShowNoise] = useState(false);
  const [open, setOpen] = useState(live || status !== "completed");

  useEffect(() => {
    if (live) setOpen(true);
    else if (status === "completed") setOpen(false);
  }, [live, status]);

  if (status === null) return null;

  const visible = showNoise ? records : records.filter((record) => !isStreamingNoise(record));
  const hidden = records.length - visible.length;
  const rows = useMemo(() => activityRows(steps, findings, live), [steps, findings, live]);
  const actionCount = steps.filter(isPrimaryActivityStep).length;
  const warningCount = findings.filter((finding) => finding.severity === "warn").length;
  const blockedCount = findings.filter((finding) => finding.severity === "violation").length;
  const redirectedCount = findings.filter(
    (finding) => isSemanticRedirect(finding),
  ).length;
  const learnedCount = findings.filter((finding) => finding.check === "learned-watch").length;
  const summary = runSummary(actionCount, warningCount, blockedCount);
  const visibleIntervention =
    blockedCount > 0
      ? {
          title: `⚠ ${blockedCount} unsafe action${blockedCount === 1 ? "" : "s"} blocked`,
          detail: "Agent recovered and completed the task.",
        }
      : redirectedCount > 0
        ? {
            title: `↩ Agent redirected${redirectedCount === 1 ? "" : ` ${redirectedCount} times`}`,
            detail: "The Agent adjusted its approach and completed the task.",
          }
        : learnedCount > 0
          ? {
              title: "⚠ Prior safety lesson applied",
              detail: "The Agent used its safety memory while completing the task.",
            }
          : null;

  return (
    <section className="trajectory">
      <header className="trajectory-head">
        {/* Collapse rather than dismiss, so the panel can always be reopened
            without re-running anything. */}
        <button
          className="trajectory-collapse"
          onClick={() => {
            if (!live) setOpen(!open);
          }}
          aria-expanded={open}
          aria-disabled={live}
          title={live ? "Activity stays open while the Agent is running" : open ? "Collapse" : "View activity"}
        >
          {live ? <span className="activity-live-dot" /> : open ? "▾" : "▸"}
        </button>

        <div className="trajectory-tabs">
          <button
            className={view === "activity" ? "tab tab-on" : "tab"}
            onClick={() => {
              setView("activity");
              setOpen(true);
            }}
          >
            Agent activity
          </button>
          <button
            className={view === "technical" ? "tab tab-on" : "tab"}
            onClick={() => {
              setView("technical");
              setOpen(true);
            }}
          >
            Technical details
          </button>
        </div>

        <span className="trajectory-count">
          {status === "waiting_approval"
            ? "Approval needed"
            : live
              ? "Running"
              : status === "completed"
                ? "Completed"
                : status}
        </span>
      </header>

      {!open && (
        <button className="activity-collapsed" onClick={() => setOpen(true)}>
          <span className="activity-complete">✓ Completed</span>
          <span>{summary}</span>
          <strong>View activity ▸</strong>
        </button>
      )}

      {!open && status === "completed" && visibleIntervention !== null && (
        <div className="activity-intervention-summary">
          <strong>{visibleIntervention.title}</strong>
          <span>{visibleIntervention.detail}</span>
        </div>
      )}

      {open && view === "activity" && (
        <>
          <ActivityList rows={rows} live={live} records={records.length} status={status} />
          {pendingApproval !== null && onApprovalDecision !== undefined && (
            <ApprovalCard
              request={pendingApproval}
              busy={approvalBusy}
              onDecision={onApprovalDecision}
            />
          )}
        </>
      )}

      {open && view === "technical" && (
        <div className="technical-details">
          <RunSafety findings={findings} />
          <div className="technical-trace-head">
            <strong>Protocol trace</strong>
            <span>{records.length} record{records.length === 1 ? "" : "s"}</span>
            <RedactionNotice count={redactions} />
          </div>
          <RawList
            records={visible}
            hidden={hidden}
            showNoise={showNoise}
            onToggleNoise={() => setShowNoise(!showNoise)}
          />
        </div>
      )}
    </section>
  );
}

const APPROVAL_REASON_COPY: Record<HumanApprovalRequest["reason"], string> = {
  high_consequence: "This action creates an external or difficult-to-reverse effect and requires confirmation.",
  semantic_uncertainty:
    "Automated supervision detected a possible conflict with the delegated task but could not justify an automatic refusal.",
  semantic_unavailable:
    "Automated safety review is temporarily unavailable for this consequential action.",
};

function ApprovalCard({
  request,
  busy,
  onDecision,
}: {
  request: HumanApprovalRequest;
  busy: boolean;
  onDecision: (decision: "approve" | "deny") => void;
}) {
  return (
    <section className="approval-card" aria-live="polite" aria-labelledby="approval-title">
      <div className="approval-heading">
        <span className="approval-icon" aria-hidden="true">?</span>
        <div>
          <span className="eyebrow">Decision required</span>
          <h3 id="approval-title">Approval needed</h3>
        </div>
      </div>
      <dl className="approval-copy">
        <div>
          <dt>The Agent wants to</dt>
          <dd>{request.summary}</dd>
        </div>
        <div>
          <dt>Why you&apos;re being asked</dt>
          <dd>{APPROVAL_REASON_COPY[request.reason]}</dd>
        </div>
      </dl>
      {request.safeDetails !== undefined && request.safeDetails.trim() !== "" && (
        <details className="approval-details">
          <summary>Details</summary>
          <pre>{request.safeDetails}</pre>
        </details>
      )}
      <div className="approval-actions">
        <button
          type="button"
          className="button button-danger"
          disabled={busy}
          onClick={() => onDecision("deny")}
        >
          Deny
        </button>
        <button
          type="button"
          className="button button-primary"
          disabled={busy}
          onClick={() => onDecision("approve")}
        >
          {busy ? "Submitting…" : "Approve once"}
        </button>
      </div>
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

function RunSafety({ findings }: { findings: NonNullable<AgentRun["findings"]> }) {
  if (findings.length === 0) return null;
  return (
    <details className="run-safety">
      <summary>Run safety <span>{findings.length} event{findings.length === 1 ? "" : "s"}</span></summary>
      {findings.map((finding, index) => (
        <div className={"security-finding finding-" + finding.severity} key={`${finding.check}:${finding.code}:${finding.seq}:${index}`}>
          <span>{finding.severity === "violation" ? "blocked" : finding.severity}</span>
          <div>
            <code>{finding.check}/{finding.code}</code>
            <p>{finding.message}</p>
            <small>Evidence: {finding.evidence.map((seq) => `#${seq}`).join(", ")}</small>
            {finding.metadata !== undefined && (
              <pre className="finding-metadata">{JSON.stringify(finding.metadata, null, 2)}</pre>
            )}
          </div>
        </div>
      ))}
    </details>
  );
}

interface ActivityRow {
  key: string;
  seq: number;
  icon: string;
  tone: "normal" | "warning" | "blocked" | "running";
  title: string;
  detail: string | null;
}

function activityRows(
  steps: TraceStep[],
  findings: Finding[],
  live: boolean,
): ActivityRow[] {
  const hasFindingRedirect = findings.some(
    (finding) => finding.check === "learned-watch" || isSemanticRedirect(finding),
  );
  const hasFindingBlock = findings.some((finding) => finding.severity === "violation");
  const rows: ActivityRow[] = [];

  for (const step of steps) {
    if (step.kind === "reply") continue;
    // Routine shell plumbing is still fully available in Technical details.
    // The default timeline focuses on intent, mutations, verification and
    // intervention rather than replaying a terminal transcript.
    if (!isPrimaryActivityStep(step)) continue;
    // Findings are the clear, attributable home for middleware interventions.
    if (step.kind === "steer" && hasFindingRedirect) continue;
    if (step.kind === "approval") {
      if (step.outcome === "allowed") continue;
      if (step.outcome === "blocked" && hasFindingBlock) continue;
    }
    rows.push(rowForStep(step, live));
  }

  const seenFindings = new Set<string>();
  for (const finding of findings) {
    const key = `${finding.check}:${finding.code}:${finding.seq}`;
    if (seenFindings.has(key)) continue;
    seenFindings.add(key);
    const row = rowForFinding(finding, key);
    if (row !== null) rows.push(row);
  }

  return rows.sort((left, right) => left.seq - right.seq);
}

function rowForStep(step: TraceStep, live: boolean): ActivityRow {
  const running = live && step.outcome === null;
  const failed = step.outcome === "failed" || step.kind === "problem";
  return {
    key: `step:${step.seq}`,
    seq: step.seq,
    icon: failed ? "×" : step.kind === "thinking" ? "◌" : running ? "◌" : step.kind === "steer" ? "↩" : "✓",
    tone: failed ? "blocked" : running ? "running" : step.kind === "steer" ? "warning" : "normal",
    title: activityTitle(step, running),
    detail: step.kind === "thinking" ? null : step.detail,
  };
}

function activityTitle(step: TraceStep, running: boolean): string {
  if (step.kind === "thinking") return reasoningTitle(step.detail, running);
  if (step.kind === "steer") return "Agent redirected";
  if (step.kind === "approval") return step.outcome === "blocked" ? "Action blocked" : "Waiting for approval";
  if (step.kind === "problem") return "Runtime error";
  if (step.kind === "file") return readableFileChange(step.title);
  if (step.kind === "search") return step.title;
  if (step.kind !== "command") return step.title;

  const command = step.title.trim();
  const read = /^(?:cat|head|tail|less|more|sed\s+-n)\s+(?:[^\s]+\s+)*([^\s;&|]+)$/.exec(command);
  if (read?.[1] !== undefined) return `Read ${read[1]}`;
  if (/\b(?:npm|pnpm|yarn)\s+(?:run\s+)?test\b|\b(?:vitest|jest|pytest|cargo test)\b/i.test(command)) {
    return running ? "Running tests…" : "Ran tests";
  }
  const concise = command.length > 90 ? command.slice(0, 87) + "…" : command;
  return running ? `Running ${concise}` : `Ran ${concise}`;
}

function isPrimaryActivityStep(step: TraceStep): boolean {
  if (step.kind !== "command" && step.kind !== "search") return true;
  if (step.kind === "search") return false;
  return isVerificationCommand(step.title);
}

function isVerificationCommand(command: string): boolean {
  return /\b(?:npm|pnpm|yarn)\s+(?:(?:run\s+)?(?:test|build|lint|typecheck)|check)\b|\b(?:vitest|jest|pytest|cargo test|go test|node\s+--test|tsc\b)/i.test(command);
}

function reasoningTitle(detail: string | null, running: boolean): string {
  if (detail === null || detail.trim() === "") return running ? "Analyzing the task…" : "Reasoning";
  const compact = detail
    .replace(/\*\*|__|`/g, "")
    .replace(/^#+\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  const sentence = compact.match(/^.{1,130}?(?:[.!?](?=\s|$)|$)/)?.[0] ?? compact;
  const summary = sentence.length > 112 ? `${sentence.slice(0, 109).trimEnd()}…` : sentence;
  return `${running ? "Analyzing" : "Reasoning"} · ${summary}`;
}

function readableFileChange(title: string): string {
  return title
    .split(", ")
    .map((entry) => {
      const match = /^(add|update|delete|changed)\s+(.+)$/.exec(entry);
      if (match === null) return entry;
      const verb = match[1] === "add" ? "Added" : match[1] === "delete" ? "Deleted" : "Updated";
      return `${verb} ${match[2]}`;
    })
    .join(", ");
}

function rowForFinding(finding: Finding, key: string): ActivityRow | null {
  if (finding.check === "human-approval") {
    const outcome = finding.metadata?.outcome;
    if (outcome === "requested") {
      return {
        key,
        seq: finding.seq,
        icon: "?",
        tone: "normal",
        title: "Approval requested",
        detail: "The Runtime paused before a user-delegated action.",
      };
    }
    if (outcome === "approved") {
      return {
        key,
        seq: finding.seq,
        icon: "✓",
        tone: "normal",
        title: "Approved once",
        detail: "The user approved this specific action.",
      };
    }
    return {
      key,
      seq: finding.seq,
      icon: "×",
      tone: "warning",
      title: outcome === "timed_out" ? "Approval timed out" : "Action denied by user",
      detail:
        outcome === "timed_out"
          ? "The action was declined and the Agent continued without it."
          : "The action was declined without counting as a safety violation.",
    };
  }

  if (finding.check === "learned-watch") {
    return {
      key,
      seq: finding.seq,
      icon: "⚠",
      tone: "warning",
      title: "Prior safety lesson applied",
      detail: "The Agent encountered a pattern associated with an earlier unsafe run.",
    };
  }

  if (
    finding.code === "ungated-command" ||
    finding.code === "ungated-file-change" ||
    finding.check === "runtime-enforcement" ||
    finding.check === "semantic-enforcement"
  ) {
    return {
      key,
      seq: finding.seq,
      icon: "⛔",
      tone: "blocked",
      title: "Runtime safety boundary failed",
      detail: "An action completed without the expected approval checkpoint. The remaining turn was stopped.",
    };
  }

  if (finding.severity === "violation") {
    const external = finding.check === "sensitive-egress" || finding.check === "outbound-blob";
    return {
      key,
      seq: finding.seq,
      icon: "⛔",
      tone: "blocked",
      title: external ? "External data transfer blocked" : "Action blocked",
      detail: external
        ? "Attempted to send sensitive workspace data outside the environment. The Agent was redirected and allowed to continue."
        : "The proposed action conflicted with the delegated task and was blocked.",
    };
  }

  if (isSemanticRedirect(finding)) {
    return {
      key,
      seq: finding.seq,
      icon: "↩",
      tone: "warning",
      title: "Agent redirected",
      detail: "The current approach conflicted with the delegated task.",
    };
  }

  if (finding.check === "semantic-intent") {
    if (finding.code === "semantic-monitor-unavailable") {
      return {
        key,
        seq: finding.seq,
        icon: "⚠",
        tone: "warning",
        title: "Safety review unavailable",
        detail: "The Agent continued because this checkpoint did not require a blocking review.",
      };
    }
    // Aligned/allow assessments are audit evidence, not interventions. Keep
    // them in Run safety under Technical details without cluttering activity.
    return null;
  }

  return {
    key,
    seq: finding.seq,
    icon: "⚠",
    tone: "warning",
    title: "Safety guidance applied",
    detail: "The Agent was guided back toward the requested task.",
  };
}

function isSemanticRedirect(finding: Finding): boolean {
  if (finding.check !== "semantic-intent") return false;
  const decision = finding.metadata?.controllerDecision;
  return decision === "steer";
}

function ActivityList(props: {
  rows: ActivityRow[];
  live: boolean;
  records: number;
  status: string;
}) {
  if (props.rows.length === 0) {
    return <p className="trajectory-empty">{emptyMessage(props.live, props.records, props.status)}</p>;
  }

  return (
    <ol className="trajectory-list">
      {props.rows.map((row) => (
        <li className={`trajectory-step activity-${row.tone}`} key={row.key}>
          <span className="step-icon" aria-hidden="true">{row.icon}</span>
          <div className="step-body">
            <span className="step-title">{row.title}</span>
            {row.detail !== null && row.detail.trim() !== "" && (
              <details className="activity-row-details">
                <summary>Details</summary>
                <pre className="step-detail">{row.detail}</pre>
              </details>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

function runSummary(actions: number, warnings: number, blocked: number): string {
  const parts = [`${actions} action${actions === 1 ? "" : "s"}`];
  if (warnings > 0) parts.push(`${warnings} safety warning${warnings === 1 ? "" : "s"}`);
  if (blocked > 0) parts.push(`${blocked} action${blocked === 1 ? "" : "s"} blocked`);
  return parts.join(" · ");
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
