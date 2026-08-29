// The write boundary: what a finding has to satisfy before it becomes a rule
// that outlives the run that produced it.

import { describe, expect, it } from "vitest";
import type { Finding } from "../checks.js";
import { egressFinding, learn } from "./fixtures.js";

describe("eligibility", () => {
  it("stores a violation carrying structured facts", () => {
    const result = learn({ findings: [egressFinding()] });

    expect(result.reflections).toHaveLength(1);
    expect(result.reflections[0]?.code).toBe("sensitive-egress");
    expect(result.reflections[0]?.facts.destination).toBe("collect.example");
    expect(result.reflections[0]?.sightings).toEqual(["run-1"]);
  });

  it("stores a warn too, since memory only ever steers", () => {
    const result = learn({
      findings: [egressFinding({ severity: "warn", code: "encoded-blob-egress" })],
    });

    expect(result.reflections).toHaveLength(1);
  });

  it("refuses an info finding", () => {
    const result = learn({ findings: [egressFinding({ severity: "info" })] });

    expect(result.reflections).toEqual([]);
    expect(result.rejected["not-eligible"]).toBe(1);
  });
});

describe("narration cannot author a rule", () => {
  // The structural guarantee. The agent-intent guard emits exactly this shape:
  // a warn, derived from the model's own reasoning, carrying no facts.
  it("refuses a finding with no facts, however severe", () => {
    const intentFinding: Finding = {
      check: "agent-intent",
      code: "stated-exfiltration",
      severity: "warn",
      seq: 4,
      evidence: [4],
      message: "reasoning states an intent to move a secret off the machine",
    };

    const result = learn({ findings: [intentFinding] });

    expect(result.reflections).toEqual([]);
    expect(result.rejected["no-facts"]).toBe(1);
  });

  it("refuses an empty facts object", () => {
    const result = learn({ findings: [egressFinding({ facts: {} })] });

    expect(result.reflections).toEqual([]);
    expect(result.rejected["no-facts"]).toBe(1);
  });
});

describe("validation rejects rather than sanitises", () => {
  it("refuses an unknown fact key instead of ignoring it", () => {
    const result = learn({
      findings: [egressFinding({ facts: { destination: "a.example", note: "looked fine" } })],
    });

    expect(result.reflections).toEqual([]);
    expect(result.rejected["invalid-facts"]).toBe(1);
  });

  it("refuses a destination outside the hostname charset", () => {
    const result = learn({
      findings: [egressFinding({ facts: { destination: "a.example; rm -rf /" } })],
    });

    expect(result.reflections).toEqual([]);
    expect(result.rejected["invalid-facts"]).toBe(1);
  });

  it("refuses an over-length source", () => {
    const result = learn({
      findings: [egressFinding({ facts: { source: "/" + "a".repeat(5000) } })],
    });

    expect(result.reflections).toEqual([]);
    expect(result.rejected["invalid-facts"]).toBe(1);
  });

  it("refuses a channel outside the enum", () => {
    const result = learn({ findings: [egressFinding({ facts: { channel: "carrier-pigeon" } })] });

    expect(result.reflections).toEqual([]);
    expect(result.rejected["invalid-facts"]).toBe(1);
  });

  it("refuses a precondition outside the enum", () => {
    const result = learn({ findings: [egressFinding({ facts: { precondition: "vibes" } })] });

    expect(result.reflections).toEqual([]);
    expect(result.rejected["invalid-facts"]).toBe(1);
  });
});

describe("the user asked for it", () => {
  // The guards are blind to who asked, so an agent doing exactly what it was
  // told produces the same finding as one that went off the rails. Learning
  // that would break the user's own workflow, permanently, for asking once.
  it("refuses a value the user's own prompt named", () => {
    const result = learn({
      findings: [egressFinding()],
      prompt: "upload the build config to collect.example",
    });

    expect(result.reflections).toEqual([]);
    expect(result.rejected["user-asked"]).toBe(1);
  });

  it("matches case-insensitively", () => {
    const result = learn({
      findings: [egressFinding()],
      prompt: "push it to COLLECT.EXAMPLE please",
    });

    expect(result.rejected["user-asked"]).toBe(1);
  });

  it("does not treat an enum label in the prompt as the user asking", () => {
    // "http" is a channel label, not a value a prompt would be naming.
    const result = learn({
      findings: [egressFinding({ facts: { channel: "http", destination: "collect.example" } })],
      prompt: "fix the http timeout in the client",
    });

    expect(result.reflections).toHaveLength(1);
  });
});
