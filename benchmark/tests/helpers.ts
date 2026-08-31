// A tiny trace builder for benchmark tests, in the style of
// apps/server/tests/reflections/loop.test.ts. Produces the item/started +
// item/completed records commandsOf() reads.

import type { TraceRecord } from "../../apps/server/src/trace.js";

export class Trace {
  private seq = 1;
  readonly records: TraceRecord[] = [];

  private push(method: string, payload: unknown): void {
    this.records.push({
      seq: this.seq++,
      at: "2026-01-01T00:00:00.000Z",
      dir: "in",
      method,
      payload,
    });
  }

  /** A completed shell command. */
  command(
    command: string,
    opts: { id?: string; exitCode?: number; output?: string; reads?: string[] } = {},
  ): this {
    const id = opts.id ?? `c${this.seq}`;
    const actions = (opts.reads ?? []).map((path) => ({ type: "read", path }));
    const item = {
      id,
      type: "commandExecution",
      command,
      cwd: "/workspace",
      commandActions: actions,
    };
    this.push("item/started", { params: { item } });
    this.push("item/completed", {
      params: {
        item: {
          ...item,
          exitCode: opts.exitCode ?? 0,
          aggregatedOutput: opts.output ?? "",
        },
      },
    });
    return this;
  }

  /** A final agent message. */
  say(text: string): this {
    this.push("item/completed", { params: { item: { id: `m${this.seq}`, type: "agentMessage", text } } });
    return this;
  }

  build(): TraceRecord[] {
    return this.records;
  }
}
