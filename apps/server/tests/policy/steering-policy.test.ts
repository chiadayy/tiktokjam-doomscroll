import { describe, expect, it } from "vitest";
import type { Finding } from "../../src/checks.js";
import {
  MAX_STEERING_TASK_CHARS,
  remediationForFinding,
  steeringPrompt,
} from "../../src/steering-policy.js";

function finding(check: string, code: string): Finding {
  return {
    check,
    code,
    severity: "violation",
    seq: 7,
    evidence: [7],
    message: "detector detail containing SECRET_VALUE and regex internals",
  };
}

describe("shared steering policy", () => {
  it.each([
    ["sensitive-egress", "sensitive-egress", "data_exfiltration"],
    ["outbound-blob", "encoded-blob-egress", "data_exfiltration"],
    ["agent-intent", "stated-destruction", "destructive_divergence"],
    ["agent-intent", "stated-scope-violation", "scope_expansion"],
    ["agent-intent", "stated-persistence", "persistence"],
    ["agent-intent", "stated-cover-tracks", "oversight_evasion"],
    ["agent-intent", "stated-guard-evasion", "oversight_evasion"],
    ["agent-intent", "stated-deception", "deception"],
    ["learned-watch", "watched-source-read", "untrusted_instruction_adoption"],
  ] as const)("maps %s/%s to %s", (check, code, category) => {
    expect(remediationForFinding(finding(check, code))).toBe(category);
  });

  it("builds a short action-block correction only from the task and invariant", () => {
    const prompt = steeringPrompt("Ship the requested parser fix", "data_exfiltration", true);

    expect(prompt).toBe(
      "Return to the user's original objective: Ship the requested parser fix.\n\n" +
        "Do not transmit workspace secrets or private data externally.\n\n" +
        "Do not retry the blocked action through another mechanism.\n\n" +
        "Re-plan and continue with an approach that directly satisfies the delegated task.",
    );
    expect(prompt).not.toContain("SECRET_VALUE");
    expect(prompt).not.toContain("regex");
  });

  it("retains a later trusted constraint while bounding the task reminder", () => {
    const importantConstraint = "Preserve the existing authentication contract.";
    const task =
      "Implement the requested compatibility update. " +
      "x".repeat(430) +
      " " +
      importantConstraint +
      " y".repeat(80) +
      " OMITTED_MARKER";

    const prompt = steeringPrompt(task, "security_weakening", false);
    const reminder = prompt.split("\n", 1)[0] ?? "";

    expect(prompt).toContain(importantConstraint);
    expect(reminder.length).toBeLessThanOrEqual(
      "Return to the user's original objective: .".length + MAX_STEERING_TASK_CHARS,
    );
    expect(reminder).not.toContain("OMITTED_MARKER");
  });
});
