// How reflections accumulate across runs: identity, dedup, and determinism.

import { describe, expect, it } from "vitest";
import { reflectionKey } from "../../src/reflections.js";
import { NOW, egressFinding, learn } from "./fixtures.js";

describe("sightings", () => {
  it("counts several findings in one run as one sighting", () => {
    const result = learn({ findings: [egressFinding(), egressFinding({ seq: 11 })] });

    expect(result.reflections).toHaveLength(1);
    expect(result.reflections[0]?.sightings).toEqual(["run-1"]);
  });

  it("grows sightings when the same reflection recurs in a later run", () => {
    const first = learn({ findings: [egressFinding()], runId: "run-1" });
    const second = learn({
      findings: [egressFinding()],
      reflections: first.reflections,
      runId: "run-2",
      now: "2026-08-30T12:00:00.000Z",
    });

    expect(second.reflections).toHaveLength(1);
    expect(second.reflections[0]?.sightings).toEqual(["run-1", "run-2"]);
    expect(second.reflections[0]?.firstSeenAt).toBe(NOW);
    expect(second.reflections[0]?.lastSeenAt).toBe("2026-08-30T12:00:00.000Z");
  });

  it("does not mutate the reflections it was given", () => {
    const first = learn({ findings: [egressFinding()], runId: "run-1" });
    const snapshot = structuredClone(first.reflections);

    learn({ findings: [egressFinding()], reflections: first.reflections, runId: "run-2" });

    expect(first.reflections).toEqual(snapshot);
  });
});

describe("dedup", () => {
  it("treats the same facts in a different key order as one reflection", () => {
    expect(reflectionKey("c", { a: "1", b: "2" })).toBe(reflectionKey("c", { b: "2", a: "1" }));
  });

  // Two preconditions are two different rules, so they must not collapse.
  it("keeps the same destination under two preconditions as two reflections", () => {
    const result = learn({
      findings: [
        egressFinding({ facts: { destination: "a.example", precondition: "sensitive-read" } }),
        egressFinding({ facts: { destination: "a.example", precondition: "encoded-blob" } }),
      ],
    });

    expect(result.reflections).toHaveLength(2);
  });
});

describe("determinism", () => {
  // The property the whole offline evaluation harness rests on: replaying a
  // recorded trace must produce exactly what the live run produced.
  it("gives the same reflections for the same inputs", () => {
    const a = learn({ findings: [egressFinding()] });
    const b = learn({ findings: [egressFinding()] });

    expect(a.reflections).toEqual(b.reflections);
  });
});
