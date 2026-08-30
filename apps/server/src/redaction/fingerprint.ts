import { createHash } from "node:crypto";

/**
 * The number of leading characters kept verbatim.
 *
 * Three is enough to tell an `sk_` from an `AKI` from a `ghp` at a glance,
 * which is the only thing the prefix is for. It stays at three deliberately:
 * every extra character is real plaintext of a real secret, and the digest
 * below already does the work of telling two values apart.
 */
const PREFIX_CHARS = 3;

/**
 * Hex digits of digest kept. Six gives ~16.7M distinct labels, which is far
 * more than the number of distinct secrets that can appear in one run, while
 * staying short enough to read inside a sentence.
 */
const DIGEST_CHARS = 6;

/**
 * A short, non-reversible label for a secret. Never the value itself.
 *
 * Shared so a redacted credential looks the same wherever it surfaces — in a
 * finding's message, in the trajectory view, in the semantic monitor's input.
 *
 * Three components, each earning its place:
 *
 *   prefix   Which *kind* of credential this is, at a glance.
 *   digest   Which *particular* credential this is. Without it, distinct
 *            secrets that share a prefix and a length collapse to the same
 *            label — two different values rendering identically in a report is
 *            worse than useless, because it reads as one value seen twice.
 *            This was not hypothetical: a real captured trace held two 50-char
 *            identifiers that both rendered as `0d6…(50 chars)`.
 *   length   How much was removed. Diagnostic, and cheap to keep.
 *
 * Non-reversibility rests on SHA-256 truncated to 24 bits. That is not enough
 * to resist a brute-force search over a *small* candidate set, so the digest is
 * an identity, never a proof: it answers "are these two labels the same
 * secret?", and is not a token to compare against a guessed value.
 */
export function fingerprint(value: string): string {
  const digest = createHash("sha256").update(value).digest("hex").slice(0, DIGEST_CHARS);
  return value.slice(0, PREFIX_CHARS) + "…" + digest + "(" + value.length + " chars)";
}

/**
 * The separator between prefix and digest, and the marker that a string has
 * already been through the redactor.
 *
 * U+2026 is load-bearing rather than decorative: every credential pattern in
 * this module matches ASCII only, so a horizontal ellipsis cannot occur inside
 * any value we would replace. That makes its presence a sound signal that we
 * are looking at our own output.
 */
export const FINGERPRINT_MARKER = "…";

/**
 * True when `text` looks like it has already been redacted.
 *
 * This tests for the bare marker, not the full fingerprint format, and the
 * difference matters. Patterns overlap — `ENV_ASSIGNMENT_PATTERN` and
 * `KEYVAL_PATTERN` both match `API_KEY=…` — so the second pattern to run sees
 * a value the first has already replaced. Its capture group often slices that
 * replacement in half (`abc…a9a9dc(20`, cut at the space before `chars)`), and
 * a check anchored to the complete format would not recognise the fragment and
 * would fingerprint the fingerprint.
 *
 * Matching the marker alone catches every fragment, which is what idempotence
 * actually requires.
 */
export function looksAlreadyRedacted(text: string): boolean {
  return text.includes(FINGERPRINT_MARKER);
}

/**
 * True when `text` contains a complete, well-formed fingerprint.
 *
 * Stricter than `looksAlreadyRedacted` and used for assertions rather than
 * control flow: it is what pins the output format in tests, so a change to
 * `fingerprint` above fails here rather than drifting silently.
 */
const FINGERPRINT_PATTERN = new RegExp(
  FINGERPRINT_MARKER + "[0-9a-f]{" + DIGEST_CHARS + "}\\(\\d+ chars\\)",
);

export function containsFingerprint(text: string): boolean {
  return FINGERPRINT_PATTERN.test(text);
}
