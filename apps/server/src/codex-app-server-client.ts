// Minimal JSON-RPC 2.0 client for `codex app-server`.
//
// Framing is bare NDJSON: one JSON object per line, `jsonrpc` omitted on the
// wire, integer request ids. Verified against
// codex-rs/app-server/src/transport.rs (reader uses BufReader::lines, writer
// appends '\n').
//
// Constructed from anything shaped like {stdin, stdout}, not a ChildProcess, so
// tests can drive it with a pair of PassThrough streams instead of Docker.

import type { Readable, Writable } from "node:stream";

export interface JsonRpcIo {
  stdin: Writable;
  stdout: Readable;
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

export type NotificationHandler = (params: Record<string, unknown>) => void;
export type ServerRequestHandler = (
  params: Record<string, unknown>,
  id: number | string,
) => void | Promise<void>;

/**
 * Called for every message crossing the wire, in both directions, before
 * anything else sees it. This is the single choke point where the raw trace is
 * captured: nothing can reach the rest of the system without passing here.
 */
export type MessageObserver = (dir: "in" | "out", message: unknown) => void;

export class JsonRpcConnection {
  private nextId = 1;
  private buffer = "";
  private readonly pending = new Map<number, Pending>();
  private readonly notificationHandlers = new Map<string, NotificationHandler>();
  private readonly requestHandlers = new Map<string, ServerRequestHandler>();
  private closed: Error | null = null;

  constructor(
    private readonly io: JsonRpcIo,
    private readonly observe?: MessageObserver,
  ) {
    io.stdout.on("data", (chunk: Buffer | string) => this.consume(chunk));
  }

  on(method: string, handler: NotificationHandler): void {
    this.notificationHandlers.set(method, handler);
  }

  onRequest(method: string, handler: ServerRequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  reply(id: number | string, result: unknown): void {
    this.write({ id, result });
  }

  request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.write({ id, method, params });
    });
  }

  /** Fail every in-flight request; called when the container dies. */
  fail(error: Error): void {
    this.closed = error;
    for (const [, waiter] of this.pending) waiter.reject(error);
    this.pending.clear();
  }

  private write(message: Record<string, unknown>): void {
    this.observe?.("out", message);
    this.io.stdin.write(JSON.stringify(message) + "\n");
  }

  private consume(chunk: Buffer | string): void {
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // Non-JSON noise on stdout is not fatal.
      }
      // Record before dispatching, so the trace holds the message even if a
      // handler throws while processing it.
      this.observe?.("in", message);
      this.dispatch(message);
    }
  }

  private dispatch(message: Record<string, unknown>): void {
    const id = message.id as number | string | undefined;
    const method = message.method as string | undefined;
    const params = (message.params ?? {}) as Record<string, unknown>;

    // Server-initiated request: has BOTH id and method. Approvals arrive here.
    if (id !== undefined && method) {
      const handler = this.requestHandlers.get(method);
      if (handler) void handler(params, id);
      return;
    }

    if (id !== undefined) {
      const waiter = this.pending.get(id as number);
      if (!waiter) return;
      this.pending.delete(id as number);
      if (message.error) {
        waiter.reject(new Error(JSON.stringify(message.error)));
      } else {
        waiter.resolve(message.result);
      }
      return;
    }

    if (method) this.notificationHandlers.get(method)?.(params);
  }
}
