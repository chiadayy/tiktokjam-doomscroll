// Curated subset of the Codex app-server protocol (v2), for reference while
// reading traces. The trace itself stores raw payloads, not these types.
//
// These are transcribed from the authoritative bindings emitted by
//   codex app-server generate-ts --out DIR
// running inside volc-agent-runtime:local (@openai/codex@0.111.0). Only the
// handful of types we actually read live here; regenerate and re-check
// these if the pinned CODEX_VERSION in Dockerfile.runtime changes.

/** `AskForApproval` — note the kebab-case spellings for the non-"untrusted" values. */
export type AskForApproval = "untrusted" | "on-failure" | "on-request" | "never";

/**
 * v2 `SandboxPolicy` is camelCase. Do NOT confuse it with the top-level
 * (non-v2) SandboxPolicy, which is snake_case with kebab-case type values
 * ("workspace-write"). Sending the wrong one fails at runtime.
 */
export type SandboxPolicy =
  | { type: "dangerFullAccess" }
  | { type: "readOnly"; access: unknown; networkAccess: boolean }
  | { type: "externalSandbox"; networkAccess: "restricted" | "enabled" }
  | {
      type: "workspaceWrite";
      writableRoots: string[];
      readOnlyAccess: unknown;
      networkAccess: boolean;
      excludeTmpdirEnvVar: boolean;
      excludeSlashTmp: boolean;
    };

/** Codex's own pre-parsed reading of a shell command. Prefer this over parsing strings. */
export type CommandAction =
  | { type: "read"; command: string; name: string; path: string }
  | { type: "listFiles"; command: string; path: string | null }
  | { type: "search"; command: string; query: string | null; path: string | null }
  | { type: "unknown"; command: string };

export type PatchChangeKind =
  | { type: "add" }
  | { type: "delete" }
  | { type: "update"; move_path: string | null };

export interface FileUpdateChange {
  path: string;
  kind: PatchChangeKind;
  diff: string;
}

/**
 * Decisions we speak on the wire. `cancel` declines AND immediately interrupts
 * the turn — one atomic reply, so a "stop" on a gated action needs no separate
 * turn/interrupt call. Both approval enums support all four.
 */
export type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

export interface TurnSteerParams {
  threadId: string;
  input: Array<{ type: "text"; text: string }>;
  /** Precondition: fails if this is not the currently active turn. */
  expectedTurnId: string;
}

export interface TurnInterruptParams {
  threadId: string;
  turnId: string;
}

/**
 * A `commandExecution` approval carries the command itself; a `fileChange`
 * approval carries ONLY ids, so the affected paths must be correlated back to
 * the earlier `item/started` notification by `itemId`.
 */
export interface CommandExecutionRequestApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  approvalId?: string | null;
  reason?: string | null;
  command?: string | null;
  cwd?: string | null;
  commandActions?: CommandAction[] | null;
}

export interface FileChangeRequestApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  reason?: string | null;
  grantRoot?: string | null;
}
