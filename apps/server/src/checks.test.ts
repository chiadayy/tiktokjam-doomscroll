import { describe, expect, it } from "vitest";
import {
  agentMessagesOf,
  approvalsOf,
  commandsOf,
  fileChangesOf,
  readsOf,
  runChecks,
  type Check,
  type Finding,
} from "./checks.js";
import type { TraceRecord } from "./trace.js";

// A trace is a plain list of objects, so a test can write one by hand. This is
// how you should test a check: build a small trace, assert what it says.
let nextSeq = 1;

function record(dir: "in" | "out", method: string | null, payload: unknown): TraceRecord {
  return { seq: nextSeq++, at: "2026-08-28T00:00:00.000Z", dir, method, payload };
}

function commandStarted(command: string, readPath?: string): TraceRecord {
  const actions = readPath === undefined ? [] : [{ type: "read", command, path: readPath }];
  return record("in", "item/started", {
    params: { item: { id: "i1", type: "commandExecution", command, cwd: "/workspace", commandActions: actions } },
  });
}

function commandFinished(command: string, exitCode: number, output: string): TraceRecord {
  return record("in", "item/completed", {
    params: {
      item: { id: "i1", type: "commandExecution", command, aggregatedOutput: output, exitCode },
    },
  });
}

function fileChanged(filePath: string, kind: string): TraceRecord {
  return record("in", "item/completed", {
    params: {
      item: {
        id: "f1",
        type: "fileChange",
        changes: [{ path: filePath, kind: { type: kind }, diff: "" }],
      },
    },
  });
}

describe("reading commands out of a trace", () => {
  it("finds both the start and the completion of a command", () => {
    const trace = [
      commandStarted("/bin/bash -lc 'ls'"),
      commandFinished("/bin/bash -lc 'ls'", 0, "a.txt\n"),
    ];

    const commands = commandsOf(trace);

    expect(commands).toHaveLength(2);
    expect(commands[0]?.phase).toBe("started");
    expect(commands[1]?.phase).toBe("completed");
    expect(commands[1]?.exitCode).toBe(0);
    expect(commands[1]?.output).toBe("a.txt\n");
  });

  it("keeps the seq number, so a finding can point back at the record", () => {
    const trace = [commandStarted("/bin/bash -lc 'pwd'")];
    expect(commandsOf(trace)[0]?.seq).toBe(trace[0]?.seq);
  });

  it("ignores records that are not commands", () => {
    const trace = [
      record("in", "turn/started", { params: { turn: { id: "t1" } } }),
      record("in", "item/completed", { params: { item: { type: "reasoning", id: "r1" } } }),
    ];
    expect(commandsOf(trace)).toEqual([]);
  });
});

describe("reading file changes out of a trace", () => {
  it("flattens one record with several changes into one entry each", () => {
    const trace = [
      record("in", "item/completed", {
        params: {
          item: {
            id: "f1",
            type: "fileChange",
            changes: [
              { path: "src/a.ts", kind: { type: "add" }, diff: "" },
              { path: "src/b.ts", kind: { type: "delete" }, diff: "" },
            ],
          },
        },
      }),
    ];

    const changes = fileChangesOf(trace);

    expect(changes.map((change) => change.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(changes.map((change) => change.kind)).toEqual(["add", "delete"]);
  });

  it("reports an unrecognised kind rather than guessing", () => {
    const trace = [fileChanged("src/a.ts", "something-new")];
    expect(fileChangesOf(trace)[0]?.kind).toBe("something-new");
  });
});

describe("reading file reads out of a trace", () => {
  it("uses the runtime's own parsing of the command", () => {
    const trace = [commandStarted("/bin/bash -lc 'cat .env'", "/workspace/.env")];
    expect(readsOf(trace)).toEqual([{ seq: trace[0]?.seq, path: "/workspace/.env" }]);
  });

  it("returns nothing when the runtime did not parse a read", () => {
    const trace = [commandStarted("/bin/bash -lc 'make build'")];
    expect(readsOf(trace)).toEqual([]);
  });
});

describe("reading approvals and agent messages", () => {
  it("finds every point where the runtime asked permission", () => {
    const trace = [
      record("in", "item/commandExecution/requestApproval", { params: { itemId: "i1" } }),
      record("out", null, { id: 1, result: { decision: "accept" } }),
    ];

    const approvals = approvalsOf(trace);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.itemId).toBe("i1");
  });

  it("finds the agent's own messages", () => {
    const trace = [
      record("in", "item/completed", {
        params: { item: { id: "m1", type: "agentMessage", text: "done" } },
      }),
    ];
    expect(agentMessagesOf(trace)[0]?.text).toBe("done");
  });
});

describe("running checks", () => {
  // An example check. Yours goes in its own file; this one only exists to show
  // the shape and to prove the machinery works.
  const noDeletes: Check = {
    name: "no-deletes",
    run(trace) {
      const findings: Finding[] = [];
      for (const change of fileChangesOf(trace)) {
        if (change.kind !== "delete") continue;
        findings.push({
          check: "no-deletes",
          code: "file-deleted",
          severity: "violation",
          seq: change.seq,
          evidence: [change.seq],
          message: `Deleted ${change.path}`,
        });
      }
      return findings;
    },
  };

  it("returns nothing when the trace is clean", () => {
    const trace = [fileChanged("src/a.ts", "add")];
    expect(runChecks([noDeletes], trace)).toEqual([]);
  });

  it("points at the exact record that justifies the finding", () => {
    const trace = [fileChanged("src/a.ts", "add"), fileChanged("src/gone.ts", "delete")];
    const findings = runChecks([noDeletes], trace);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.evidence).toEqual([trace[1]?.seq]);
  });

  it("gives the same answer every time it sees the same trace", () => {
    const trace = [fileChanged("src/gone.ts", "delete")];
    expect(runChecks([noDeletes], trace)).toEqual(runChecks([noDeletes], trace));
  });

  it("gives the same answer live as it does offline", () => {
    // Live, a check sees the trace grow one record at a time. Offline it sees
    // the whole thing at once. Both must agree, or what you tested is not what
    // runs.
    const trace = [fileChanged("src/a.ts", "add"), fileChanged("src/gone.ts", "delete")];

    const offline = runChecks([noDeletes], trace);

    let live: Finding[] = [];
    for (let index = 1; index <= trace.length; index += 1) {
      live = runChecks([noDeletes], trace.slice(0, index));
    }

    expect(live).toEqual(offline);
  });
});
