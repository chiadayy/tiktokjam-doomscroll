// Credential redaction: one pattern registry, two tiers, three consumers.
//
//   check-sensitive-egress.ts  DETECTION_PATTERNS + fingerprint  (precision)
//   app.ts onSend hook         redactText                        (recall)
//   semantic-intent-monitor.ts redactSensitiveText               (recall)
//
// See ./patterns.ts for why the tiers differ.

export {
  containsFingerprint,
  fingerprint,
  FINGERPRINT_MARKER,
  looksAlreadyRedacted,
} from "./fingerprint.js";
export {
  CREDENTIAL_PATTERNS,
  DETECTION_PATTERNS,
  KEYVAL_PATTERN,
  LONG_BASE64_PATTERN,
  PROTOCOL_ID_KEYS,
  PROTOCOL_ID_PATTERN,
  PROTOCOL_ID_PREFIXES,
  REDACTION_PATTERNS,
} from "./patterns.js";
export { redactText, redactSensitiveText, type RedactionResult } from "./redact.js";
