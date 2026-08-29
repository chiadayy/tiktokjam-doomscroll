// paramsFrom: the only route by which memory reaches a run.

import { describe, expect, it } from "vitest";
import { paramsFrom, type Reflection } from "../../src/reflections.js";
import { NOW } from "./fixtures.js";

describe("paramsFrom", () => {
  // Memory widens what the guards notice; it never widens what they refuse.
  it("produces no blocking list, at any number of sightings", () => {
    const reflections: Reflection[] = [
      {
        code: "sensitive-egress",
        facts: { destination: "collect.example", precondition: "sensitive-read" },
        sightings: ["run-1", "run-2", "run-3", "run-4"],
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      },
    ];

    const params = paramsFrom(reflections);

    expect(Object.keys(params).sort()).toEqual(["watchedDestinations", "watchedFiles"]);
    expect(params.watchedDestinations).toEqual([
      { value: "collect.example", precondition: "sensitive-read" },
    ]);
  });

  // An egress reflection's `source` is the secret that was read, not the file whose
  // contents preceded the step. Watching .env would say nothing useful.
  it("only routes an instruction-source reflection to watched files", () => {
    const reflections: Reflection[] = [
      {
        code: "sensitive-egress",
        facts: { source: "/workspace/.env", precondition: "sensitive-read" },
        sightings: ["run-1"],
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      },
      {
        code: "instruction-source",
        facts: { source: "/workspace/deploy-helper.md", precondition: "untrusted-source-read" },
        sightings: ["run-1"],
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      },
    ];

    expect(paramsFrom(reflections).watchedFiles).toEqual([
      { value: "/workspace/deploy-helper.md", precondition: "untrusted-source-read" },
    ]);
  });

  it("carries the precondition through so a rule stays scoped", () => {
    const reflections: Reflection[] = [
      {
        code: "sensitive-egress",
        facts: { destination: "a.example", precondition: "encoded-blob" },
        sightings: ["run-1"],
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      },
    ];

    expect(paramsFrom(reflections).watchedDestinations[0]?.precondition).toBe("encoded-blob");
  });

  it("is a pure function of its input", () => {
    const reflections: Reflection[] = [
      {
        code: "instruction-source",
        facts: { source: "/workspace/a.md", precondition: "none" },
        sightings: ["run-1"],
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      },
    ];
    const snapshot = structuredClone(reflections);

    paramsFrom(reflections);

    expect(reflections).toEqual(snapshot);
  });

  it("returns empty lists for no reflections", () => {
    expect(paramsFrom([])).toEqual({ watchedDestinations: [], watchedFiles: [] });
  });
});
