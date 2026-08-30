import type { AppConfig } from "./config.js";
import type { AskForApproval } from "./codex-protocol.js";
import type { TurnOptions } from "./run-turn.js";

/**
 * The security-relevant portion of a live Codex turn, resolved once rather
 * than spread across the runner and JSON-RPC call sites.
 *
 * Codex app-server 0.111.0 was probed with `approvalPolicy: "on-request"`
 * and the v2 `readOnly` policy. A read (`cat`) ran normally; an editor write
 * produced `item/fileChange/requestApproval` while its target did not exist;
 * and a shell redirect produced `item/commandExecution/requestApproval`
 * before its target existed. This gives semantic enforcement a real barrier,
 * rather than treating an asynchronous item notification as one.
 */
export interface TurnSecurityPolicy {
  sandboxMode: TurnOptions["sandboxMode"];
  denyNetwork: boolean;
  approvalPolicy?: AskForApproval;
  /** True only when the Runtime is required to gate workspace writes. */
  semanticEnforcement: boolean;
}

export function resolveTurnSecurityPolicy(config: AppConfig): TurnSecurityPolicy {
  if (config.semanticGuardEnabled) {
    return {
      // `workspaceWrite` permits mutations with no approval notification.
      // `readOnly` keeps inspection cheap but makes writes request approval.
      sandboxMode: "read-only",
      // This also gives semantic-only turns a pre-execution boundary for
      // network/external effects such as git push or publish.
      denyNetwork: true,
      approvalPolicy: "on-request",
      semanticEnforcement: true,
    };
  }

  if (config.egressGuardEnabled) {
    return {
      // Preserve the established egress policy. Explicitly retaining
      // on-request avoids relying on a Codex config-file default.
      //
      // Measured, 2026-08-30: no approval mode gates an outbound command on
      // app-server 0.111.0. Across four runs — no policy, "on-request", and
      // "untrusted" — zero item/commandExecution/requestApproval were emitted
      // for a curl, so the decline path is unreachable for network egress and
      // turn/interrupt is the only enforcement available. "untrusted" is worse
      // than useless here: it added no gating and the agent abandoned the task
      // after two commands. Do not reach for it again without re-probing.
      sandboxMode: config.guardrailSandbox,
      denyNetwork: true,
      approvalPolicy: "on-request",
      semanticEnforcement: false,
    };
  }

  return {
    sandboxMode: config.codexSandboxMode,
    denyNetwork: false,
    semanticEnforcement: false,
  };
}
