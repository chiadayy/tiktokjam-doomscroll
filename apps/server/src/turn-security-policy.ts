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
   * before its target existed. This gives guarded effects a real barrier,
 * rather than treating an asynchronous item notification as one.
 */
export interface TurnSecurityPolicy {
  sandboxMode: TurnOptions["sandboxMode"];
  denyNetwork: boolean;
  approvalPolicy?: AskForApproval;
  /** True only when the Runtime is required to gate workspace writes. */
  semanticEnforcement: boolean;
  /** True when hard guards rely on the verified pre-execution boundary. */
  effectGating: boolean;
}

export function resolveTurnSecurityPolicy(config: AppConfig): TurnSecurityPolicy {
  if (config.semanticGuardEnabled || config.egressGuardEnabled) {
    return {
      // `workspaceWrite` permits mutations with no approval notification.
      // `readOnly` keeps inspection cheap but makes writes request approval.
      sandboxMode: "read-only",
      // This also gives guarded turns a pre-execution boundary for
      // network/external effects such as git push or publish.
      denyNetwork: true,
      approvalPolicy: "on-request",
      semanticEnforcement: config.semanticGuardEnabled,
      effectGating: true,
    };
  }

  return {
    sandboxMode: config.codexSandboxMode,
    denyNetwork: false,
    semanticEnforcement: false,
    effectGating: false,
  };
}
