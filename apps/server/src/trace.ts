// Append-only raw trace of one agent run.
//
// Every message that crosses the wire between us and the agent runtime is
// written here verbatim, in order, with nothing removed and nothing derived.
// Interpretation happens later, from a separate pass over this file, and can
// never overwrite the original.
//
// Traces are NOT stored in the JSON database. That store rewrites the entire
// file on every mutation (see store.ts), so appending a few hundred events per
// run would rewrite every agent, message and past run a few hundred times. A
// log wants append-only; the store is the wrong shape for one.
//
// Format is JSON Lines: one JSON object per line, readable with jq, Python, or
// anything that can split on newlines. No parser of ours sits in the way.

import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

/** Direction of travel: `in` from the agent runtime, `out` from us. */
export type TraceDirection = "in" | "out";

export interface TraceSummary {
  path: string;
  events: number;
  bytes: number;
  /** True when the size cap was hit and later events were dropped. */
  truncated: boolean;
}

export interface TraceRecord {
  /** Our counter, so ordering survives identical timestamps. */
  seq: number;
  at: string;
  dir: TraceDirection;
  /** JSON-RPC method when the message has one, else null. */
  method: string | null;
  /** The untouched message. Never edited, never filtered. */
  payload: unknown;
}

export function traceFilePath(dataDirectory: string, runId: string): string {
  return path.join(dataDirectory, "traces", `${runId}.jsonl`);
}

/**
 * JSON-RPC messages have a "method" when they are a request or a notification,
 * and no method when they are a response. We store it at the top level so a
 * reader can filter on it without digging into the payload.
 */
function readMethodName(message: unknown): string | null {
  if (message === null) return null;
  if (typeof message !== "object") return null;

  const method = (message as Record<string, unknown>).method;
  if (typeof method === "string") return method;
  return null;
}

/**
 * One record, one line. A payload that will not serialise still gets a line,
 * so the sequence numbers never have silent holes in them.
 */
function toJsonLine(record: TraceRecord): string {
  try {
    return JSON.stringify(record) + "\n";
  } catch {
    const placeholder = { ...record, payload: { unserializable: true } };
    return JSON.stringify(placeholder) + "\n";
  }
}

export class TraceWriter {
  private stream: WriteStream | null = null;
  private seq = 0;
  private bytes = 0;
  private truncated = false;

  constructor(
    private readonly filePath: string,
    /** Stop appending past this size rather than silently dropping the middle. */
    private readonly maxBytes = 16 * 1024 * 1024,
  ) {}

  async open(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    this.stream = createWriteStream(this.filePath, { flags: "a", mode: 0o600 });
  }

  /**
   * Record one message. Synchronous and non-throwing on purpose: this sits on
   * the hot path between the agent and the rest of the system, and a tracing
   * failure must never change what the agent is allowed to do.
   */
  record(dir: TraceDirection, message: unknown): void {
    if (this.stream === null) return;
    if (this.truncated) return;

    this.seq += 1;

    const record: TraceRecord = {
      seq: this.seq,
      at: new Date().toISOString(),
      dir: dir,
      method: readMethodName(message),
      payload: message,
    };

    const line = toJsonLine(record);

    if (this.bytes + line.length > this.maxBytes) {
      this.truncated = true;
      this.stream.write(this.truncationNotice());
      return;
    }

    this.bytes += line.length;
    this.stream.write(line);
  }

  private truncationNotice(): string {
    const notice: TraceRecord = {
      seq: this.seq,
      at: new Date().toISOString(),
      dir: "out",
      method: "trace/truncated",
      payload: { reason: "maxBytes exceeded", maxBytes: this.maxBytes },
    };
    return JSON.stringify(notice) + "\n";
  }

  async close(): Promise<TraceSummary> {
    const stream = this.stream;
    this.stream = null;
    if (stream) {
      await new Promise<void>((resolve) => stream.end(() => resolve()));
    }
    return {
      path: this.filePath,
      events: this.seq,
      bytes: this.bytes,
      truncated: this.truncated,
    };
  }
}
