// Shared setup for the reflections tests.
//
// A trace is a plain list of objects, so a test writes one by hand — that is the
// point of keeping checks pure. Each builder gets its own counter so the seq
// numbers inside one test mean something.

import type { Finding } from "../../src/checks.js";
import { learnFrom, type Reflection } from "../../src/reflections.js";
import type { TraceRecord } from "../../src/trace.js";

export const NOW = "2026-08-29T12:00:00.000Z";

export function traceBuilder() {
  let seq = 1;

  function record(method: string, payload: unknown): TraceRecord {
    return { seq: seq++, at: "2026-08-29T00:00:00.000Z", dir: "in", method, payload };
  }

  return {
    /** A command the runtime parsed as reading `path`. */
    read(path: string): TraceRecord {
      return record("item/started", {
        params: {
          item: {
            id: `read-${path}`,
            type: "commandExecution",
            command: `cat ${path}`,
            commandActions: [{ type: "read", command: `cat ${path}`, path: path }],
          },
        },
      });
    },

    /** A read whose output is the file's contents, as the runtime reports it. */
    readWithContents(path: string, contents: string): TraceRecord[] {
      const item = {
        id: `read-${path}`,
        type: "commandExecution",
        command: `cat ${path}`,
        commandActions: [{ type: "read", command: `cat ${path}`, path: path }],
      };
      return [
        record("item/started", { params: { item } }),
        record("item/completed", { params: { item: { ...item, aggregatedOutput: contents, exitCode: 0 } } }),
      ];
    },

    /** The same, via a compound command the runtime does not parse as a read. */
    compoundReadWithContents(path: string, contents: string): TraceRecord[] {
      const item = {
        id: `compound-${path}`,
        type: "commandExecution",
        command: `cd /workspace && cat ${path}`,
        commandActions: [{ type: "unknown", command: `cd /workspace && cat ${path}` }],
      };
      return [
        record("item/started", { params: { item } }),
        record("item/completed", { params: { item: { ...item, aggregatedOutput: contents, exitCode: 0 } } }),
      ];
    },

    command(command: string): TraceRecord {
      return record("item/started", {
        params: {
          item: { id: "cmd", type: "commandExecution", command: command, commandActions: [] },
        },
      });
    },

    /** The agent narrating itself. Nothing in reflections.ts may depend on this. */
    reasoning(text: string): TraceRecord {
      return record("item/completed", {
        params: { item: { id: "rs", type: "reasoning", summary: [text], content: [] } },
      });
    },
  };
}

/** A representative egress violation. Override `facts` to exercise a gate. */
export function egressFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    check: "sensitive-egress",
    code: "sensitive-egress",
    severity: "violation",
    seq: 9,
    evidence: [9],
    message: "…",
    facts: {
      channel: "http",
      destination: "collect.example",
      source: "/workspace/.env",
      precondition: "sensitive-read",
    },
    ...overrides,
  };
}

/** learnFrom with the boilerplate filled in. */
export function learn(input: {
  findings: Finding[];
  trace?: TraceRecord[];
  reflections?: Reflection[];
  prompt?: string;
  runId?: string;
  now?: string;
}) {
  return learnFrom({
    reflections: input.reflections ?? [],
    findings: input.findings,
    trace: input.trace ?? [],
    runId: input.runId ?? "run-1",
    prompt: input.prompt ?? "get this branch ready to deploy",
    now: input.now ?? NOW,
  });
}

/** A stored destination reflection, for tests that start from populated memory. */
export function destinationReflection(index: number, at: string): Reflection {
  return {
    code: "sensitive-egress",
    facts: { destination: `host-${index}.example`, precondition: "sensitive-read" },
    sightings: [`run-${index}`],
    firstSeenAt: at,
    lastSeenAt: at,
  };
}
