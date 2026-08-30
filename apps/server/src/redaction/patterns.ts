// The one place in this repo that defines what a credential looks like.
//
// There are two tiers, and they exist because detection and redaction want
// opposite things from the same patterns:
//
//   DETECTION  A false positive blocks a legitimate agent action, so this tier
//              is conservative. Used by the egress guard to decide whether a
//              command is carrying a secret out.
//
//   REDACTION  A false positive makes one string in a log less readable — and
//              the unredacted trace is still on disk. A false negative puts a
//              credential on someone's screen. So this tier is deliberately
//              trigger-happy.
//
// REDACTION is a strict superset of DETECTION, and a test pins that. Two
// independent lists is what this module exists to prevent: the failure mode is
// a guard that blocks a credential and then renders it in the trajectory view.

/** Shapes that are almost certainly a credential, wherever they appear. */
export const CREDENTIAL_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/,
  /sk_(?:live|test)_[A-Za-z0-9]{16,}/,
  /AKIA[0-9A-Z]{16}/,
  /AIza[0-9A-Za-z_-]{35}/,
  /gh[pousr]_[A-Za-z0-9]{36,}/,
  /xox[baprs]-[0-9A-Za-z-]{10,}/,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

/** `SECRET=...`, `API_KEY: ...` and friends. The value is capture group 1. */
export const KEYVAL_PATTERN =
  /(?:SECRET|TOKEN|PASSWORD|API[_-]?KEY|ACCESS[_-]?KEY)\s*[=:]\s*["']?([^\s"']{8,})/i;

/** A long unbroken base64 run. Lower confidence, so only harvested, never a gate. */
export const LONG_BASE64_PATTERN = /[A-Za-z0-9+/]{40,}={0,2}/;

/** What the egress guard gates on. Conservative by design — see the header. */
export const DETECTION_PATTERNS: RegExp[] = CREDENTIAL_PATTERNS;

// ---------------------------------------------------------------------------
// The recall tier
// ---------------------------------------------------------------------------
//
// Everything above, plus shapes we would not block an agent over but will not
// put on a screen either.

/** A whole PEM block, not just its header, so the body never survives. */
export const PEM_BLOCK_PATTERN =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/;

/** A long unbroken hex run: raw key material, digests, session tokens. */
export const LONG_HEX_PATTERN = /\b[0-9a-fA-F]{32,}\b/;

/** The value after an auth header, whatever shape it takes. */
export const AUTH_HEADER_PATTERN =
  /(?:Authorization|X-Api-Key|X-Auth-Token)\s*:\s*(?:Bearer\s+|Basic\s+|token\s+)?([^\s"',;]{8,})/i;

/** A bare `Bearer <token>` outside a header line. */
export const BEARER_PATTERN = /\b(?:Bearer|Basic)\s+([A-Za-z0-9._~+/=-]{16,})/;

/**
 * `ANYTHING_KEY=value` — broader than KEYVAL_PATTERN, which only knows a fixed
 * keyword list. An `.env` dump is the motivating case: the variable is named
 * after the vendor, not after the word "SECRET".
 */
export const ENV_ASSIGNMENT_PATTERN =
  /\b([A-Z][A-Z0-9_]{2,}(?:KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL|AUTH))\s*[=:]\s*["']?([^\s"']{8,})/;

// ---------------------------------------------------------------------------
// The one thing we deliberately do not redact
// ---------------------------------------------------------------------------

/**
 * Codex protocol identifiers, which `LONG_BASE64_PATTERN` and
 * `LONG_HEX_PATTERN` would otherwise swallow wholesale.
 *
 * Measured on a real 794-event trace: of 462 redactions, **458 were Codex
 * reasoning-item ids** and only 4 were the actual credential. Six unique ids,
 * repeated across nearly every record. Left alone, the Raw trajectory view —
 * the one that gets projected during a demo — becomes a wall of fingerprints
 * with the real finding lost in it.
 *
 * The exclusion is written to be narrow and auditable, because an exclusion in
 * a redactor is exactly where a leak hides:
 *
 *   * It matches on STRUCTURAL CONTEXT, never on a bare prefix. The value must
 *     appear as the value of a known identifier key (`"id": "…"`,
 *     `"call_id": "…"`, `"item_id": "…"`) or carry a known protocol prefix
 *     *within that key/value position*. A secret that merely happens to begin
 *     with `rs_` somewhere in free text is still redacted.
 *   * It applies only to the two low-confidence recall patterns. Anything that
 *     matches a real credential shape in `CREDENTIAL_PATTERNS` is redacted no
 *     matter where it sits — a key named `"id"` cannot launder an `sk_live_`.
 *
 * If this ever needs widening, widen it here and nowhere else, so the full list
 * of what we chose not to redact stays readable in one place.
 */
export const PROTOCOL_ID_KEYS = ["id", "item_id", "itemId", "call_id", "callId"];
export const PROTOCOL_ID_PREFIXES = ["rs_", "call_", "item_", "msg_", "fc_"];

/**
 * A long run sitting in identifier position: `"id":"rs_05cc…"`, or a bare
 * `"call_id":"05cc…"`. The alternation is context-then-value, so the value
 * alone never satisfies it.
 */
export const PROTOCOL_ID_PATTERN = new RegExp(
  "\"(?:" +
    PROTOCOL_ID_KEYS.join("|") +
    ")\"\\s*:\\s*\"(?:" +
    PROTOCOL_ID_PREFIXES.map((prefix) => prefix.replace(/_/g, "_")).join("|") +
    ")?[A-Za-z0-9+/_-]{20,}={0,2}\"",
  "g",
);

/**
 * Every pattern the redactor applies, in order. PEM first so a whole block is
 * taken before the header-only pattern can match a fragment of it.
 *
 * Each entry names the capture group holding the secret, or 0 for the whole
 * match, so one replace loop handles both shapes.
 *
 * `excludable` marks the two low-confidence recall patterns, the only ones the
 * protocol-id exclusion above is allowed to hold back.
 */
export const REDACTION_PATTERNS: Array<{
  pattern: RegExp;
  group: number;
  excludable?: boolean;
}> = [
  { pattern: PEM_BLOCK_PATTERN, group: 0 },
  ...CREDENTIAL_PATTERNS.map((pattern) => ({ pattern: pattern, group: 0 })),
  { pattern: AUTH_HEADER_PATTERN, group: 1 },
  { pattern: BEARER_PATTERN, group: 1 },
  { pattern: ENV_ASSIGNMENT_PATTERN, group: 2 },
  { pattern: KEYVAL_PATTERN, group: 1 },
  { pattern: LONG_BASE64_PATTERN, group: 0, excludable: true },
  { pattern: LONG_HEX_PATTERN, group: 0, excludable: true },
];
