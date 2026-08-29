// Bounded memory, and the reason the caps are partitioned per code.

import { describe, expect, it } from "vitest";
import { evict, type Reflection } from "../reflections.js";
import { NOW, destinationReflection } from "./fixtures.js";

const sourceReflection: Reflection = {
  code: "instruction-source",
  facts: { source: "/workspace/deploy-helper.md", precondition: "untrusted-source-read" },
  sightings: ["run-0"],
  // Deliberately stale: it only refreshes when that file is read again.
  firstSeenAt: "2026-01-01T00:00:00.000Z",
  lastSeenAt: "2026-01-01T00:00:00.000Z",
};

describe("evict", () => {
  // The regression test for the eviction attack. Under one global cap, a burst
  // of destination reflections — an agent looping against rotating hosts — carries
  // fresh timestamps and pushes out the stale source reflection, which is precisely
  // the one that generalises across hosts.
  it("evicts within a code, never across codes", () => {
    const flood = Array.from({ length: 400 }, (_, index) =>
      destinationReflection(index, "2026-08-29T00:00:00.000Z"),
    );

    const kept = evict([sourceReflection, ...flood], { "instruction-source": 50 });

    expect(kept).toContainEqual(sourceReflection);
    expect(kept.filter((reflection) => reflection.code === "sensitive-egress")).toHaveLength(150);
  });

  it("keeps the most recently seen within a partition", () => {
    const old = destinationReflection(1, "2026-01-01T00:00:00.000Z");
    const recent = destinationReflection(2, "2026-08-29T00:00:00.000Z");

    expect(evict([old, recent], { "sensitive-egress": 1 })).toEqual([recent]);
  });

  it("leaves a list under the cap untouched, in order", () => {
    const reflections = [destinationReflection(1, NOW), destinationReflection(2, NOW)];

    expect(evict(reflections, {})).toEqual(reflections);
  });

  it("preserves input order among survivors so the stored list stays diffable", () => {
    const reflections = [
      destinationReflection(1, "2026-08-01T00:00:00.000Z"),
      destinationReflection(2, "2026-01-01T00:00:00.000Z"),
      destinationReflection(3, "2026-08-02T00:00:00.000Z"),
    ];

    const kept = evict(reflections, { "sensitive-egress": 2 });

    expect(kept.map((reflection) => reflection.facts.destination)).toEqual([
      "host-1.example",
      "host-3.example",
    ]);
  });
});
