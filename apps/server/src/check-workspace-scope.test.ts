import { describe, expect, it } from "vitest";
import { workspaceScopeCheck } from "./check-workspace-scope.js";
import type { TraceRecord } from "./trace.js";

// A check takes a trace and returns findings. Nothing else. So a test only has
// to build a trace, which is a plain list of objects you can write by hand.

let nextSeq = 1;

function fileChanged(path: string): TraceRecord {
  return {
    seq: nextSeq++,
    at: "2026-08-28T00:00:00.000Z",
    dir: "in",
    method: "item/completed",
    payload: {
      params: {
        item: {
          id: "f" + nextSeq,
          type: "fileChange",
          changes: [{ path, kind: { type: "add" }, diff: "" }],
          status: "completed",
        },
      },
    },
  };
}

const check = workspaceScopeCheck({ allowedPrefixes: ["/workspace/src/", "/workspace/tests/"] });

describe("workspace scope check", () => {
  it("says nothing about writes inside the allowed paths", () => {
    const trace = [fileChanged("/workspace/src/app.ts"), fileChanged("/workspace/tests/app.test.ts")];
    expect(check.run(trace)).toEqual([]);
  });

  it("flags a write outside them", () => {
    const trace = [fileChanged("/workspace/secrets/keys.txt")];
    const findings = check.run(trace);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      check: "workspace-scope",
      code: "write-outside-scope",
      severity: "violation",
    });
  });

  it("points at the record that justifies the finding", () => {
    // Evidence is what lets a reader open the trace and check for themselves.
    const trace = [fileChanged("/workspace/src/ok.ts"), fileChanged("/workspace/bad.txt")];
    const findings = check.run(trace);
    expect(findings[0]?.evidence).toEqual([trace[1]?.seq]);
  });

  it("tells the agent what to do instead, not only what was wrong", () => {
    const trace = [fileChanged("/workspace/bad.txt")];
    const steer = check.run(trace)[0]?.steer ?? "";

    expect(steer).toContain("/workspace/bad.txt");
    expect(steer).toContain("/workspace/src/");
  });

  it("gives the same answer every time, and live matches offline", () => {
    const trace = [fileChanged("/workspace/src/a.ts"), fileChanged("/workspace/bad.txt")];

    const offline = check.run(trace);

    // Live, a check sees the trace grow one record at a time.
    let live = check.run(trace.slice(0, 1));
    live = check.run(trace.slice(0, 2));

    expect(live).toEqual(offline);
  });

  it("ignores records that are not file changes", () => {
    const trace: TraceRecord[] = [
      { seq: 99, at: "", dir: "in", method: "turn/started", payload: { params: {} } },
    ];
    expect(check.run(trace)).toEqual([]);
  });
});

describe("bugs found by a real agent run", () => {
  function fileEvent(path: string, kind: string, method: string): TraceRecord {
    return {
      seq: nextSeq++,
      at: "2026-08-28T00:00:00.000Z",
      dir: "in",
      method,
      payload: {
        params: {
          item: {
            id: "item-" + path,
            type: "fileChange",
            changes: [{ path, kind: { type: kind }, diff: "" }],
            status: method === "item/started" ? "inProgress" : "completed",
          },
        },
      },
    };
  }

  it("objects once per change, not once per phase", () => {
    // A change is reported twice, starting and completing. The live run
    // produced two corrections for one mistake because of this.
    const trace = [
      fileEvent("/workspace/notes.txt", "add", "item/started"),
      fileEvent("/workspace/notes.txt", "add", "item/completed"),
    ];
    expect(check.run(trace)).toHaveLength(1);
  });

  it("does not object to the agent undoing what we objected to", () => {
    // We tell the agent to undo the change. It deletes the file. That delete is
    // also outside scope, so without this the agent is corrected for obeying,
    // and the two of you loop.
    const trace = [
      fileEvent("/workspace/notes.txt", "add", "item/completed"),
      fileEvent("/workspace/notes.txt", "delete", "item/completed"),
    ];
    expect(check.run(trace)).toHaveLength(1);
  });
});
