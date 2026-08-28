import type { RunTrace } from "./types.js";

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export class RunCancelledError extends Error {
  constructor() {
    super("Run cancelled");
    this.name = "RunCancelledError";
  }
}

/**
 * A failed run is the one you most want the trace for, so the pointer travels
 * out on the error rather than being lost with it.
 */
export interface TracedError extends Error {
  trace?: RunTrace;
}

export function attachTrace(error: Error, trace: RunTrace): TracedError {
  const traced = error as TracedError;
  traced.trace = trace;
  return traced;
}

export function traceOf(error: unknown): RunTrace | null {
  if (error === null || typeof error !== "object") return null;
  const trace = (error as TracedError).trace;
  return trace === undefined ? null : trace;
}
