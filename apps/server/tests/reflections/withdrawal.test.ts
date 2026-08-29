// Withdrawal. Not a nicety: the guards are blind to who asked, so without a way
// back, one run doing exactly what the user wanted leaves a rule they cannot
// clear.

import { describe, expect, it } from "vitest";
import { paramsFrom, withdraw } from "../../src/reflections.js";
import { egressFinding, learn } from "./fixtures.js";

describe("withdraw", () => {
  it("removes a reflection so it no longer reaches the guards", () => {
    const result = learn({ findings: [egressFinding()] });
    const reflection = result.reflections[0];
    if (reflection === undefined) throw new Error("expected a reflection");

    const remaining = withdraw(result.reflections, reflection.code, reflection.facts);

    expect(remaining).toEqual([]);
    expect(paramsFrom(remaining).watchedDestinations).toEqual([]);
  });

  it("leaves other reflections alone", () => {
    const result = learn({
      findings: [
        egressFinding({ facts: { destination: "a.example", precondition: "none" } }),
        egressFinding({ facts: { destination: "b.example", precondition: "none" } }),
      ],
    });

    const remaining = withdraw(result.reflections, "sensitive-egress", {
      destination: "a.example",
      precondition: "none",
    });

    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.facts.destination).toBe("b.example");
  });

  it("matches regardless of key order", () => {
    const result = learn({
      findings: [egressFinding({ facts: { destination: "a.example", precondition: "none" } })],
    });

    const remaining = withdraw(result.reflections, "sensitive-egress", {
      precondition: "none",
      destination: "a.example",
    });

    expect(remaining).toEqual([]);
  });

  it("is a no-op for a reflection that was never stored", () => {
    const result = learn({ findings: [egressFinding()] });

    const remaining = withdraw(result.reflections, "sensitive-egress", { destination: "nope.example" });

    expect(remaining).toEqual(result.reflections);
  });
});
