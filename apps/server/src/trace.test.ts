import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TraceWriter, traceFilePath, type TraceRecord } from "./trace.js";

async function newTraceFile(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "trace-test-"));
  return path.join(directory, "run.jsonl");
}

/** Read a trace file back as a list of records, the way a check would. */
async function readTrace(filePath: string): Promise<TraceRecord[]> {
  const contents = await readFile(filePath, "utf8");
  const lines = contents.split("\n").filter((line) => line.trim() !== "");
  return lines.map((line) => JSON.parse(line) as TraceRecord);
}

describe("trace file layout", () => {
  it("puts each run in its own file under the data directory", () => {
    expect(traceFilePath("/tmp/data", "run-1")).toBe("/tmp/data/traces/run-1.jsonl");
  });
});

describe("recording", () => {
  it("writes one line per message, in order, with the payload untouched", async () => {
    const filePath = await newTraceFile();
    const writer = new TraceWriter(filePath);
    await writer.open();

    writer.record("out", { id: 1, method: "initialize", params: { a: 1 } });
    writer.record("in", { id: 1, result: { ok: true } });
    writer.record("in", { method: "item/started", params: { item: { type: "commandExecution" } } });

    const summary = await writer.close();
    const records = await readTrace(filePath);

    expect(summary.events).toBe(3);
    expect(records.map((record) => record.seq)).toEqual([1, 2, 3]);
    expect(records.map((record) => record.dir)).toEqual(["out", "in", "in"]);

    // The payload must come back exactly as it went in. This is the whole point
    // of the file: it is evidence, not our summary of the evidence.
    expect(records[0]?.payload).toEqual({ id: 1, method: "initialize", params: { a: 1 } });
  });

  it("lifts the method name to the top level so readers can filter on it", async () => {
    const filePath = await newTraceFile();
    const writer = new TraceWriter(filePath);
    await writer.open();

    writer.record("in", { method: "turn/completed", params: {} });
    writer.record("in", { id: 7, result: {} }); // a response has no method

    await writer.close();
    const records = await readTrace(filePath);

    expect(records[0]?.method).toBe("turn/completed");
    expect(records[1]?.method).toBe(null);
  });

  it("records our own replies, so nobody has to trust that we auto-accepted", async () => {
    const filePath = await newTraceFile();
    const writer = new TraceWriter(filePath);
    await writer.open();

    writer.record("in", { id: 9, method: "item/commandExecution/requestApproval", params: {} });
    writer.record("out", { id: 9, result: { decision: "accept" } });

    await writer.close();
    const records = await readTrace(filePath);

    expect(records[1]?.dir).toBe("out");
    expect(records[1]?.payload).toEqual({ id: 9, result: { decision: "accept" } });
  });
});

describe("size cap", () => {
  it("stops appending and says so, rather than dropping the middle silently", async () => {
    const filePath = await newTraceFile();
    const writer = new TraceWriter(filePath, 200);
    await writer.open();

    writer.record("in", { method: "small", params: {} });
    writer.record("in", { method: "big", params: { blob: "x".repeat(500) } });
    writer.record("in", { method: "after", params: {} });

    const summary = await writer.close();
    const records = await readTrace(filePath);

    expect(summary.truncated).toBe(true);
    expect(records.some((record) => record.method === "trace/truncated")).toBe(true);
    expect(records.some((record) => record.method === "after")).toBe(false);
  });
});

describe("failure handling", () => {
  it("never throws on a payload that cannot be serialised", async () => {
    const filePath = await newTraceFile();
    const writer = new TraceWriter(filePath);
    await writer.open();

    // A cycle cannot be turned into JSON. Tracing sits between the agent and
    // everything else, so a tracing failure must not become an agent failure.
    const cyclic: Record<string, unknown> = { method: "loop" };
    cyclic.self = cyclic;

    expect(() => writer.record("in", cyclic)).not.toThrow();

    await writer.close();
    const records = await readTrace(filePath);
    expect(records[0]?.payload).toEqual({ unserializable: true });
  });

  it("ignores records written before open, instead of crashing", async () => {
    const filePath = await newTraceFile();
    const writer = new TraceWriter(filePath);

    expect(() => writer.record("in", { method: "early" })).not.toThrow();

    const summary = await writer.close();
    expect(summary.events).toBe(0);
  });
});

describe("carrying the trace out of a failed run", () => {
  it("attaches the pointer to the error and reads it back", async () => {
    const { attachTrace, traceOf } = await import("./errors.js");

    const summary = { path: "/tmp/run.jsonl", events: 12, bytes: 900, truncated: false };
    const failure = attachTrace(new Error("container died"), summary);

    // A failed run is the one you most want the evidence for, so the pointer
    // has to survive the throw.
    expect(traceOf(failure)).toEqual(summary);
    expect(failure.message).toBe("container died");
  });

  it("returns null for errors that carry no trace", async () => {
    const { traceOf } = await import("./errors.js");
    expect(traceOf(new Error("plain"))).toBe(null);
    expect(traceOf(null)).toBe(null);
    expect(traceOf("not an error")).toBe(null);
  });
});
