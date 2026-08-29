import {
  commandsOf,
  fileChangesOf,
  readsOf,
  reasoningOf,
} from "./checks.js";
import type {
  SemanticActionSummary,
  SemanticAssessment,
  SemanticMonitorInput,
  SemanticProposedAction,
  SemanticReasoningEntry,
  SemanticSource,
  TrustedTaskContext,
} from "./semantic-intent-monitor.js";
import type { TraceRecord } from "./trace.js";

const MAX_REASONING = 6;
const MAX_ACTIONS = 10;
const MAX_SOURCES = 10;
const MAX_TEXT = 2_000;

/**
 * Bounded semantic context derived from the raw trace. The JSONL trace remains
 * the source of truth; this is only a small live working set for model calls.
 */
export class TrajectoryState {
  private seenSeq = 0;
  private readonly reasoning: SemanticReasoningEntry[] = [];
  private readonly actions: SemanticActionSummary[] = [];
  private readonly sources: SemanticSource[] = [];
  private latestAssessment: SemanticAssessment | undefined;
  private risk = 0;

  constructor(readonly trustedTask: TrustedTaskContext) {}

  sync(trace: TraceRecord[]): void {
    for (const record of trace) {
      if (record.seq <= this.seenSeq) continue;
      this.seenSeq = Math.max(this.seenSeq, record.seq);

      for (const entry of reasoningOf([record])) {
        this.reasoning.push({ seq: entry.seq, text: trim(entry.text) });
      }
      for (const read of readsOf([record])) {
        this.sources.push({
          seq: read.seq,
          path: trim(read.path),
          authority: "workspace_context",
        });
      }
      for (const command of commandsOf([record])) {
        if (command.phase !== "completed") continue;
        this.actions.push({
          seq: command.seq,
          type: command.output?.trim() ? "tool_output" : "command",
          summary: trim(
            command.output?.trim()
              ? `${command.command}\nOutput: ${command.output}`
              : command.command,
          ),
        });
      }
      for (const change of fileChangesOf([record])) {
        if (change.phase !== "completed") continue;
        this.actions.push({
          seq: change.seq,
          type: "file_change",
          summary: trim(`${change.kind} ${change.path}\n${change.diff}`),
        });
      }
    }

    retainLast(this.reasoning, MAX_REASONING);
    retainLast(this.actions, MAX_ACTIONS);
    retainLast(this.sources, MAX_SOURCES);
  }

  monitorInput(
    checkpoint: SemanticMonitorInput["checkpoint"],
    cheapIntentSignal: boolean,
    proposedAction?: SemanticProposedAction,
  ): SemanticMonitorInput {
    return {
      checkpoint,
      trustedTask: this.trustedTask,
      recentReasoning: structuredClone(this.reasoning),
      recentActions: structuredClone(this.actions),
      recentSources: structuredClone(this.sources),
      ...(proposedAction === undefined ? {} : { proposedAction }),
      ...(this.latestAssessment === undefined
        ? {}
        : { previousAssessment: structuredClone(this.latestAssessment) }),
      cheapIntentSignal,
    };
  }

  recordAssessment(assessment: SemanticAssessment): void {
    this.latestAssessment = assessment;
    // Risk can cool down after a clearly aligned assessment, but does not
    // instantly disappear after a suspicious trajectory.
    this.risk = assessment.conflictsWithTask
      ? Math.max(this.risk, assessment.riskScore)
      : Math.max(0, Math.min(assessment.riskScore, this.risk * 0.5));
  }

  currentRisk(): number {
    return this.risk;
  }
}

function retainLast<T>(items: T[], maximum: number): void {
  if (items.length > maximum) items.splice(0, items.length - maximum);
}

function trim(text: string): string {
  const normalized = text.trim();
  return normalized.length <= MAX_TEXT ? normalized : normalized.slice(0, MAX_TEXT) + "…";
}
