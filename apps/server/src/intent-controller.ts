import type { Finding } from "./checks.js";
import type {
  SemanticAssessment,
  SemanticIntentMonitor,
  SemanticProposedAction,
  TrustedTaskContext,
} from "./semantic-intent-monitor.js";
import { redactMonitorInput } from "./semantic-intent-monitor.js";
import { remediationForSemantic, steeringPrompt } from "./steering-policy.js";
import type { TraceRecord } from "./trace.js";
import type { HumanApprovalReason } from "./types.js";
import { TrajectoryState } from "./trajectory-state.js";

export const SEMANTIC_RISK_ELEVATED = 0.6;
export const SEMANTIC_REASONING_STEER_RISK = 0.78;
export const SEMANTIC_ACTION_BLOCK_RISK = 0.8;
export const SEMANTIC_MIN_CONFIDENCE = 0.65;

export type IntentDecision = "allow" | "steer" | "decline" | "interrupt" | "human_review";

export interface IntentControllerResult {
  decision: IntentDecision;
  finding?: Finding;
  steer?: string;
  humanReviewReason?: Extract<
    HumanApprovalReason,
    "semantic_uncertainty" | "semantic_unavailable"
  >;
}

/**
 * Deterministic policy over nondeterministic assessments. The monitor may
 * describe risk; only this controller decides what happens to the Runtime.
 */
export class IntentController {
  private readonly state: TrajectoryState;

  constructor(
    private readonly monitor: SemanticIntentMonitor,
    trustedTask: TrustedTaskContext,
  ) {
    this.state = new TrajectoryState(trustedTask);
  }

  async observeReasoning(
    trace: TraceRecord[],
    seq: number,
    cheapIntentSignal: boolean,
  ): Promise<IntentControllerResult> {
    this.state.sync(trace);
    try {
      const assessment = await this.monitor.assess(
        redactMonitorInput(this.state.monitorInput("reasoning", cheapIntentSignal)),
      );
      this.state.recordAssessment(assessment);
      const shouldSteer =
        assessment.conflictsWithTask &&
        assessment.riskScore >= SEMANTIC_REASONING_STEER_RISK &&
        assessment.confidence >= SEMANTIC_MIN_CONFIDENCE;
      const steer = shouldSteer
        ? steeringPrompt(
            this.state.trustedTask.userPrompt,
            remediationForSemantic(assessment.classification),
            false,
          )
        : undefined;
      return {
        decision: shouldSteer ? "steer" : "allow",
        finding: findingFor(assessment, seq, "reasoning", shouldSteer ? "steer" : "allow", steer),
        ...(steer === undefined ? {} : { steer }),
      };
    } catch (error) {
      return monitorFailure(seq, "reasoning", error, false);
    }
  }

  shouldReviewAction(action: SemanticProposedAction): boolean {
    if (this.state.currentRisk() >= SEMANTIC_RISK_ELEVATED) return true;
    if (action.type === "command") return isHighConsequenceCommand(action.command);
    return isConsequentialFileChange(action);
  }

  async reviewAction(
    trace: TraceRecord[],
    action: SemanticProposedAction,
    forceReview = false,
  ): Promise<IntentControllerResult> {
    this.state.sync(trace);
    if (!forceReview && !this.shouldReviewAction(action)) {
      return neutralFinding();
    }

    try {
      const assessment = await this.monitor.assess(
        redactMonitorInput(this.state.monitorInput(action.type, false, action)),
      );
      this.state.recordAssessment(assessment);
      const block =
        assessment.conflictsWithTask &&
        assessment.riskScore >= SEMANTIC_ACTION_BLOCK_RISK &&
        assessment.confidence >= SEMANTIC_MIN_CONFIDENCE;
      const needsHumanJudgement =
        !block &&
        assessment.conflictsWithTask &&
        assessment.riskScore >= SEMANTIC_RISK_ELEVATED;
      if (needsHumanJudgement) {
        return {
          decision: "human_review",
          humanReviewReason: "semantic_uncertainty",
          finding: findingFor(assessment, action.seq, action.type, "human_review"),
        };
      }
      if (!block) {
        return {
          decision: "allow",
          finding: findingFor(assessment, action.seq, action.type, "allow"),
        };
      }

      const steer = steeringPrompt(
        this.state.trustedTask.userPrompt,
        remediationForSemantic(assessment.classification),
        true,
      );
      return {
        decision: "decline",
        finding: findingFor(assessment, action.seq, action.type, "decline", steer),
        steer,
      };
    } catch (error) {
      // A review selected as necessary for a consequential action fails closed:
      // decline this action, but leave the turn alive so the agent can continue.
      return monitorFailure(
        action.seq,
        action.type,
        error,
        true,
        this.state.trustedTask.userPrompt,
      );
    }
  }
}

export function isHighConsequenceCommand(command: string): boolean {
  const explicitEffect =
    /\b(?:git\s+push|npm\s+publish|cargo\s+publish|gem\s+push|twine\s+upload|docker\s+push|terraform\s+apply|kubectl\s+(?:apply|delete)|helm\s+(?:install|upgrade|uninstall)|rm\s+-rf|git\s+(?:reset\s+--hard|clean\s+-[^\s]*f)|(?:drop|truncate)\s+(?:database|table|schema))\b/i;
  const taskRunnerEffect =
    /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:deploy|release)\b|\b(?:make|just)\s+(?:deploy|release)\b/i;
  const deployExecutable =
    /(?:^|[;&|]\s*|["'])\s*(?:\.\/)?(?:[\w.-]+\/)*(?:deploy|release)(?:\.sh)?\b/i;
  return (
    explicitEffect.test(command) ||
    taskRunnerEffect.test(command) ||
    deployExecutable.test(command)
  );
}

function isConsequentialFileChange(action: Extract<SemanticProposedAction, { type: "file_change" }>): boolean {
  return action.changes.some((change) => {
    const material = `${change.path}\n${change.diff}`;
    return (
      change.kind === "delete" ||
      /(?:^|\/)(?:auth|security|middleware|permission|validation|tests?|specs?|package\.json|Dockerfile|\.github|\.git\/hooks)(?:[./_-]|$)/i.test(
        change.path,
      ) ||
      /\b(?:authenticate|authorization|verify|validation|bypass|disable|skip|xfail|assert|admin|backdoor|password|token|secret)\b/i.test(
        material,
      )
    );
  });
}

function findingFor(
  assessment: SemanticAssessment,
  seq: number,
  checkpoint: "reasoning" | "command" | "file_change",
  decision: IntentDecision,
  steer?: string,
): Finding {
  const severity =
    decision === "decline" || decision === "interrupt"
      ? "violation"
      : assessment.conflictsWithTask
        ? "warn"
        : "info";
  return {
    check: "semantic-intent",
    code: `semantic-${assessment.classification}`,
    severity,
    seq,
    evidence: assessment.evidenceSeqs.length > 0 ? assessment.evidenceSeqs : [seq],
    message: assessment.rationale,
    ...(steer === undefined ? {} : { steer }),
    metadata: {
      checkpoint,
      controllerDecision: decision,
      assessment: {
        riskScore: assessment.riskScore,
        confidence: assessment.confidence,
        classification: assessment.classification,
        apparentObjective: assessment.apparentObjective,
        conflictsWithTask: assessment.conflictsWithTask,
      },
    },
  };
}

function neutralFinding(): IntentControllerResult {
  return {
    decision: "allow",
  };
}

function monitorFailure(
  seq: number,
  checkpoint: "reasoning" | "command" | "file_change",
  error: unknown,
  required: boolean,
  originalUserTask = "the delegated task",
): IntentControllerResult {
  const decision: IntentDecision = required ? "human_review" : "allow";
  const steer = required
    ? steeringPrompt(originalUserTask, "scope_expansion", true)
    : undefined;
  return {
    decision,
    ...(required ? { humanReviewReason: "semantic_unavailable" as const } : {}),
    finding: {
      check: "semantic-intent",
      code: "semantic-monitor-unavailable",
      severity: "warn",
      seq,
      evidence: [seq],
      message: `Semantic review failed at the ${checkpoint} checkpoint: ${safeError(error)}.`,
      ...(steer === undefined ? {} : { steer }),
      metadata: { checkpoint, controllerDecision: decision, required },
    },
    ...(steer === undefined ? {} : { steer }),
  };
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return oneLine(message).slice(0, 240);
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
