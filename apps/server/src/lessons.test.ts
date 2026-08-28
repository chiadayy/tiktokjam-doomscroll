import { describe, expect, it } from "vitest";
import type { Finding } from "./checks.js";
import { learnFrom, preambleFor, selectFor } from "./lessons.js";
import type { Lesson } from "./types.js";

function finding(code: string, lesson?: string, severity: Finding["severity"] = "violation"): Finding {
  return {
    check: "example",
    code,
    severity,
    seq: 1,
    evidence: [1],
    message: "something happened",
    ...(lesson === undefined ? {} : { lesson }),
  };
}

function lesson(instruction: string, over: Partial<Lesson> = {}): Lesson {
  return {
    code: "example",
    learnedFrom: "run-0",
    learnedAt: "2026-08-28T00:00:00.000Z",
    instruction,
    severity: "violation",
    timesBroken: 1,
    ...over,
  };
}

describe("learning", () => {
  it("keeps a lesson from a finding that carries one", () => {
    const lessons = learnFrom([], [finding("scope", "Only write under src/.")], "run-1");
    expect(lessons).toHaveLength(1);
    expect(lessons[0]).toMatchObject({ learnedFrom: "run-1", timesBroken: 1 });
  });

  it("ignores findings with nothing to teach", () => {
    expect(learnFrom([], [finding("noted")], "run-1")).toEqual([]);
  });

  it("counts a repeat instead of storing it twice", () => {
    const once = learnFrom([], [finding("scope", "Only write under src/.")], "run-1");
    const twice = learnFrom(once, [finding("scope", "Only write under src/.")], "run-2");

    expect(twice).toHaveLength(1);
    expect(twice[0]?.timesBroken).toBe(2);
    // Attribution stays with the run that first taught it.
    expect(twice[0]?.learnedFrom).toBe("run-1");
  });

  it("never removes or weakens a lesson, whatever happens later", () => {
    // The property the whole design rests on: nothing an agent does makes the
    // system more permissive than it already was.
    const existing = learnFrom([], [finding("a", "Never touch /etc.")], "run-1");
    const after = learnFrom(existing, [], "run-2");

    expect(after).toEqual(existing);
  });
});

describe("choosing what to show", () => {
  it("shows everything when it fits", () => {
    const all = [lesson("one"), lesson("two")];
    expect(selectFor(all, "any task", 5)).toEqual(all);
  });

  it("prefers rules the agent keeps breaking", () => {
    const stubborn = lesson("Never write to the project root.", { timesBroken: 4 });
    const once = lesson("Never install packages.", { timesBroken: 1 });

    const picked = selectFor([once, stubborn], "unrelated task", 1);
    expect(picked[0]).toBe(stubborn);
  });

  it("prefers rules that bear on the task at hand", () => {
    const aboutTests = lesson("Only modify files under /workspace/tests/.");
    const aboutNetwork = lesson("Never reach the network or install packages.");

    const picked = selectFor([aboutNetwork, aboutTests], "fix the failing tests", 1);
    expect(picked[0]).toBe(aboutTests);
  });

  it("ranks a violation above a note when nothing else separates them", () => {
    const note = lesson("Prefer relative imports.", { severity: "info" });
    const violation = lesson("Never leave the workspace.", { severity: "violation" });

    const picked = selectFor([note, violation], "unrelated", 1);
    expect(picked[0]).toBe(violation);
  });

  it("does not let one stubborn rule crowd out everything else", () => {
    // Repeats have diminishing returns, so a rule broken 50 times cannot
    // outrank a highly relevant one by sheer weight of history.
    const stubborn = lesson("Never write to the project root.", { timesBroken: 50 });
    const relevant = lesson("Only modify files under /workspace/tests/.");

    const picked = selectFor([stubborn, relevant], "fix the failing tests in tests/", 2);
    expect(picked).toContain(relevant);
  });

  it("does not fade a rule as it ages", () => {
    // Deliberately unlike Generative Agents, which decays by recency. A safety
    // rule does not become less true with time, and decaying it would hand
    // permission back to an agent that had it taken away.
    const old = lesson("Never write outside src/.", { learnedAt: "2020-01-01T00:00:00.000Z" });
    const recent = lesson("Prefer tabs.", { learnedAt: "2026-08-28T00:00:00.000Z", severity: "info" });

    const picked = selectFor([old, recent], "unrelated task", 1);
    expect(picked[0]).toBe(old);
  });
});

describe("the preamble", () => {
  it("says nothing when there is nothing to say", () => {
    expect(preambleFor([])).toBe(null);
  });

  it("lists the rules as standing instructions", () => {
    const text = preambleFor([lesson("Only write under src/.")]) ?? "";
    expect(text).toContain("Standing rules");
    expect(text).toContain("Only write under src/.");
  });
});
