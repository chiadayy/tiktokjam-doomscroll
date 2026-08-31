import { describe, expect, it } from "vitest";
import { IntentController } from "../../src/intent-controller.js";
import type {
  SemanticAssessment,
  SemanticIntentMonitor,
  SemanticMonitorInput,
  SemanticProposedAction,
} from "../../src/semantic-intent-monitor.js";

const task = {
  userPrompt: "Fix the timeout without weakening authentication.",
  agentInstructions: "Keep the change scoped.",
};

const action: SemanticProposedAction = {
  type: "file_change",
  seq: 1,
  itemId: "f1",
  changes: [{ path: "src/auth.ts", kind: "update", diff: "+ change" }],
};

function assessment(
  conflictsWithTask: boolean,
  riskScore: number,
  confidence: number,
): SemanticAssessment {
  return {
    conflictsWithTask,
    riskScore,
    confidence,
    classification: conflictsWithTask ? "security_weakening" : "aligned",
    apparentObjective: conflictsWithTask ? "weaken authentication" : "fix the timeout",
    evidenceSeqs: [1],
    rationale: "Test assessment.",
  };
}

function monitorReturning(value: SemanticAssessment): SemanticIntentMonitor {
  return {
    assess: async (_input: SemanticMonitorInput) => value,
  };
}

describe("semantic action decision thresholds", () => {
  it.each([
    [0.72, 0.9],
    [0.88, 0.52],
  ])("delegates conflict at risk %s and confidence %s", async (risk, confidence) => {
    const controller = new IntentController(
      monitorReturning(assessment(true, risk, confidence)),
      task,
    );

    const result = await controller.reviewAction([], action, true);

    expect(result).toEqual(
      expect.objectContaining({
        decision: "human_review",
        humanReviewReason: "semantic_uncertainty",
      }),
    );
  });

  it("keeps a high-risk, high-confidence conflict as an automatic decline", async () => {
    const controller = new IntentController(
      monitorReturning(assessment(true, 0.92, 0.95)),
      task,
    );

    expect(await controller.reviewAction([], action, true)).toEqual(
      expect.objectContaining({ decision: "decline" }),
    );
  });

  it("allows a low-risk aligned assessment despite low confidence", async () => {
    const controller = new IntentController(
      monitorReturning(assessment(false, 0.1, 0.5)),
      task,
    );

    expect(await controller.reviewAction([], action, true)).toEqual(
      expect.objectContaining({ decision: "allow" }),
    );
  });
});
