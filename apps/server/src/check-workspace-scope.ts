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

      for (const change of fileChangesOf(trace)) {
        if (isAllowed(change.path, options.allowedPrefixes)) continue;

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
        });
      }

      return findings;
    },
  };
}

function isAllowed(path: string, allowedPrefixes: string[]): boolean {
  return allowedPrefixes.some((prefix) => path.startsWith(prefix));
}
