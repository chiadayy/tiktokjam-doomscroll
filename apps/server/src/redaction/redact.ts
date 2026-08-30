// Redaction of credential-shaped text on its way out of the process.
//
// This runs on responses, never on the trace as it is written, and the
// asymmetry is the design.
//
// What redaction costs, precisely: `fingerprint()` turns `sk_live_…` into
// `sk_…123727(28 chars)`, which does not match `/sk_(?:live|test)_[A-Za-z0-9]{16,}/`.
// So `looksCredentialShaped()` is false on a fingerprint, and a redacted trace
// **cannot reproduce value-flow findings** — the class where a credential
// printed by one command is reused verbatim by a later one. That evidence is
// destroyed by redaction with no path back. Redacting on write would therefore
// have made a whole category of guard permanently unreplayable.
//
// Keeping the on-disk file authoritative preserves the property the design
// rests on: a check written today can be replayed against a run recorded last
// week. Live enforcement is unaffected either way, because checks read the
// in-memory records array, never the file.
//
// Measured, so the claim is not theoretical. Replaying both captured golden
// traces through `scripts/replay-trace.ts`, redacted against raw, produces
// byte-identical findings: the sensitive-egress violation and both
// learned-watch warnings survive. They survive because those findings are
// reached through the marker-path and prior-read routes
// (`precondition: sensitive-read`, `source: .env`) rather than through value
// flow. That is a fact about these two traces, not a general guarantee — a run
// whose only evidence is value flow would lose its finding under redaction.
// This is why no test asserts value-flow equivalence.
//
// See the module header in ./patterns.ts for why the two pattern tiers differ.

import { fingerprint, looksAlreadyRedacted } from "./fingerprint.js";
import { PROTOCOL_ID_PATTERN, REDACTION_PATTERNS } from "./patterns.js";

export interface RedactionResult {
  text: string;
  /** How many values were replaced. Surfaced so an altered log says it was altered. */
  redactions: number;
}

/**
 * Replace every credential-shaped value in `text` with a fingerprint.
 *
 * Operates on raw text rather than parsed structures, so it catches secrets
 * nested anywhere in a payload — including inside JSON string escapes — without
 * needing to know any schema. One function therefore serves both a JSON body
 * and a JSON Lines trace.
 *
 * Replacements keep the surrounding bytes intact, so a JSON document stays
 * parseable and a JSON Lines file keeps its line count and `seq` ordering.
 */
export function redactText(text: string): RedactionResult {
  if (text === "") return { text: text, redactions: 0 };

  // Character offsets occupied by Codex protocol identifiers. The two
  // low-confidence patterns skip anything overlapping these; every real
  // credential shape ignores the set entirely, so a key named "id" cannot be
  // used to smuggle an `sk_live_` past the redactor. See PROTOCOL_ID_PATTERN.
  const excluded = protocolIdSpans(text);

  let result = text;
  let redactions = 0;

  for (const { pattern, group, excludable } of REDACTION_PATTERNS) {
    const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
    result = result.replace(global, (match: string, ...args: unknown[]) => {
      const captured = group === 0 ? match : args[group - 1];
      if (typeof captured !== "string" || captured === "") return match;
      // Already redacted by an earlier pattern in this pass, or by an earlier
      // call: leave it alone rather than fingerprinting a fingerprint.
      if (looksAlreadyRedacted(captured)) return match;

      // The offset is only meaningful on the first pass, before any
      // replacement has shifted the string. Earlier patterns are all
      // credential shapes, which are never excluded, so by the time an
      // excludable pattern runs the offsets it cares about are still valid
      // unless a real credential was replaced — and in a trace holding both,
      // over-redacting an id is the safe direction to fail.
      if (excludable === true) {
        const offset = args[args.length - 2];
        if (typeof offset === "number" && overlapsExcluded(offset, match.length, excluded)) {
          return match;
        }
      }

      redactions += 1;
      return match.replace(captured, fingerprint(captured));
    });
  }

  return { text: result, redactions: redactions };
}

/** Half-open `[start, end)` ranges holding a Codex protocol identifier. */
function protocolIdSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const global = new RegExp(PROTOCOL_ID_PATTERN.source, "g");
  for (const match of text.matchAll(global)) {
    if (match.index === undefined) continue;
    spans.push([match.index, match.index + match[0].length]);
  }
  return spans;
}

function overlapsExcluded(
  start: number,
  length: number,
  spans: Array<[number, number]>,
): boolean {
  const end = start + length;
  for (const [spanStart, spanEnd] of spans) {
    if (start < spanEnd && end > spanStart) return true;
  }
  return false;
}

/**
 * Best-effort DLP for text leaving the machine for a model provider.
 *
 * Same pattern set as `redactText`, kept as a separate name because the callers
 * mean different things: this one is about what we send outward, `redactText`
 * is about what we show the user. Both want recall over precision.
 */
export function redactSensitiveText(text: string): string {
  return redactText(text).text;
}
