// A worked example of a check. Copy this shape; replace the logic.
//
// It watches for the agent writing outside the paths it is allowed to touch,
// and corrects it mid-run rather than killing the task.
//
// The point of this file is not the rule, which is deliberately simple. It is
// to show the whole loop working: a trace comes in, a finding comes out, and
// the middleware acts on it while the agent is still running.

import { fileChangesOf, type Check, type Finding } from "./checks.js";

/** Paths the agent may write to, as prefixes under the workspace root. */
export interface ScopeOptions {
  allowedPrefixes: string[];
}

/**
 * Everything the agent writes must sit under one of the allowed prefixes.
 *
 * Paths arrive from the runtime as container paths (`/workspace/src/a.ts`), so
 * compare against that root rather than anything on the host.
 */
export function workspaceScopeCheck(options: ScopeOptions): Check {
  return {
    name: "workspace-scope",

    run(trace) {
      const findings: Finding[] = [];
      /** Paths we have already objected to, so we object once. */
      const objectedTo = new Set<string>();

      for (const change of fileChangesOf(trace)) {
        // A change appears twice in the trace, once starting and once
        // completing. Without this the same change produces two findings, and
        // the agent gets corrected twice for one mistake.
        if (change.phase !== "completed") continue;

        if (isAllowed(change.path, options.allowedPrefixes)) continue;

        // Deleting a file we objected to is the agent doing what we asked, not
        // a new violation. Without this we correct it for complying, which is
        // both wrong and a loop: correct, it undoes, correct again.
        if (change.kind === "delete" && objectedTo.has(change.path)) continue;

        if (objectedTo.has(change.path)) continue;
        objectedTo.add(change.path);

        findings.push({
          check: "workspace-scope",
          code: "write-outside-scope",
          severity: "violation",
          seq: change.seq,
          evidence: [change.seq],
          message: `Wrote ${change.path}, which is outside the allowed scope.`,
          // Name the offending path and the allowed scope. An agent told only
          // "no" will usually try the same thing again.
          steer:
            `Stop. ${change.path} is outside the scope you may write to. ` +
            `You may only modify files under: ${options.allowedPrefixes.join(", ")}. ` +
            `Undo that change if you can, then continue the original task within those paths.`,
          // A standing rule for future turns, so the next run starts already
          // knowing this rather than having to be corrected again.
          lesson:
            `Only create or modify files under: ${options.allowedPrefixes.join(", ")}. ` +
            `Never write anywhere else in the workspace.`,
        });
      }

      return findings;
    },
  };
}

function isAllowed(path: string, allowedPrefixes: string[]): boolean {
  return allowedPrefixes.some((prefix) => path.startsWith(prefix));
}
