// The redaction module's own tests.
//
// The one that matters most is the superset property below. Everything else
// here checks that redaction does what it says; that one checks that the two
// pattern tiers cannot drift apart, which is the reason the module exists at
// all. Without it you eventually get a guard that blocks a credential on the
// way out of the container and then renders the same credential in the
// trajectory view.

import { describe, expect, it } from "vitest";
import { looksCredentialShaped } from "../../src/check-sensitive-egress.js";
import {
  containsFingerprint,
  DETECTION_PATTERNS,
  fingerprint,
  KEYVAL_PATTERN,
  redactText,
} from "../../src/redaction/index.js";

/**
 * One string per credential shape the redactor claims to handle, each holding
 * a value that must not survive. Kept as literals rather than generated from
 * the patterns: a test that builds its input from the same regex it is
 * checking passes even when the regex is wrong.
 */
const SECRETS: Array<{ label: string; text: string; secret: string }> = [
  { label: "OpenAI-style key", text: "key: sk-abcdefghijklmnopqrstuvwxyz123456", secret: "sk-abcdefghijklmnopqrstuvwxyz123456" },
  { label: "Stripe live key", text: "STRIPE=sk_live_ABCDEFGHIJKLMNOP1234", secret: "sk_live_ABCDEFGHIJKLMNOP1234" },
  { label: "AWS access key id", text: "aws_access_key_id = AKIAIOSFODNN7EXAMPLE", secret: "AKIAIOSFODNN7EXAMPLE" },
  { label: "Google API key", text: "url?key=AIza" + "b".repeat(35), secret: "AIza" + "b".repeat(35) },
  { label: "GitHub token", text: "token ghp_" + "c".repeat(36), secret: "ghp_" + "c".repeat(36) },
  { label: "Slack token", text: "xoxb-123456789012-abcdefghij", secret: "xoxb-123456789012-abcdefghij" },
  {
    label: "JWT",
    text: "bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1rXwW1gFWFOEjXk",
    secret: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1rXwW1gFWFOEjXk",
  },
  {
    label: "PEM private key body",
    text: "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAsecret\n-----END RSA PRIVATE KEY-----",
    secret: "MIIEowIBAAKCAQEAsecret",
  },
  { label: "keyword assignment", text: "API_KEY=abcdefghijklmnop1234", secret: "abcdefghijklmnop1234" },
  { label: "vendor-named env assignment", text: "STRIPE_SECRET=zzzzzzzzzzzzzzzz", secret: "zzzzzzzzzzzzzzzz" },
  { label: "auth header", text: "Authorization: Bearer secret-value-1234", secret: "secret-value-1234" },
  { label: "bare bearer token", text: "Bearer abcdefghijklmnop1234", secret: "abcdefghijklmnop1234" },
  { label: "long hex run", text: "digest " + "deadbeef".repeat(4), secret: "deadbeef".repeat(4) },
  {
    label: "long base64 run",
    text: "blob QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVoxMjM0NTY3ODkw",
    secret: "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVoxMjM0NTY3ODkw",
  },
];

describe("redactText", () => {
  for (const { label, text, secret } of SECRETS) {
    it(`reduces a ${label} to a fingerprint`, () => {
      const result = redactText(text);
      expect(result.text).not.toContain(secret);
      expect(result.redactions).toBeGreaterThan(0);
      expect(containsFingerprint(result.text)).toBe(true);
    });
  }

  it("leaves ordinary text alone", () => {
    const text = "Read src/pricing.ts and ran the unit tests. 3 passed, 0 failed.";
    expect(redactText(text)).toEqual({ text: text, redactions: 0 });
  });

  it("reports nothing redacted for an empty body", () => {
    expect(redactText("")).toEqual({ text: "", redactions: 0 });
  });
});

// ---------------------------------------------------------------------------
// The invariant this module exists to hold
// ---------------------------------------------------------------------------

describe("the redaction tier is a superset of the detection tier", () => {
  // Detection decides whether to block an agent, so it is tuned for precision.
  // Redaction decides whether to show a human, so it is tuned for recall. They
  // are allowed to differ in exactly one direction: anything detection catches,
  // redaction must also catch. The reverse is fine and expected.
  for (const pattern of DETECTION_PATTERNS) {
    it(`redacts everything matched by ${pattern.source.slice(0, 40)}`, () => {
      const sample = SECRETS.find((entry) => pattern.test(entry.text));
      // Every detection pattern needs a representative above. If this throws,
      // a pattern was added without a sample and the invariant is untested for
      // it — which is the drift this suite is here to prevent.
      expect(sample, `no sample covers ${pattern.source}`).toBeDefined();
      const result = redactText(sample!.text);
      expect(result.text).not.toContain(sample!.secret);
    });
  }

  it("redacts every string the egress guard considers credential-shaped", () => {
    for (const { label, text, secret } of SECRETS) {
      if (!looksCredentialShaped(text)) continue;
      const result = redactText(text);
      expect(result.redactions, label).toBeGreaterThan(0);
      expect(result.text, label).not.toContain(secret);
    }
  });

  it("holds for the keyword-assignment shape the guard gates on", () => {
    const text = "TOKEN=supersecretvalue123";
    expect(KEYVAL_PATTERN.test(text)).toBe(true);
    expect(looksCredentialShaped(text)).toBe(true);
    expect(redactText(text).text).not.toContain("supersecretvalue123");
  });
});

// ---------------------------------------------------------------------------
// The exclusion, and its limits
// ---------------------------------------------------------------------------

describe("Codex protocol identifiers", () => {
  // Measured on a real trace: 458 of 462 redactions were reasoning-item ids.
  // Redacting those makes the Raw trajectory view unreadable without removing
  // any secret, so they are excluded — but only in identifier position.
  const REASONING_ID = "05cc2eb4531df126016a93c328fa9487d09aecd5c54df94d77";

  it("leaves a reasoning id in identifier position alone", () => {
    const line = JSON.stringify({ type: "reasoning", id: "rs_" + REASONING_ID });
    expect(redactText(line)).toEqual({ text: line, redactions: 0 });
  });

  it("leaves call_id and item_id alone", () => {
    for (const key of ["call_id", "item_id", "itemId", "callId"]) {
      const line = JSON.stringify({ [key]: REASONING_ID });
      expect(redactText(line), key).toEqual({ text: line, redactions: 0 });
    }
  });

  // The exclusion is context-based, and this is the test that proves it. A
  // value of the same length and charset as a reasoning id is still redacted
  // when it is not sitting in an identifier field.
  it("still redacts a same-shaped value outside identifier position", () => {
    const line = JSON.stringify({ stdout: REASONING_ID });
    const result = redactText(line);
    expect(result.text).not.toContain(REASONING_ID);
    expect(result.redactions).toBe(1);
  });

  // The exclusion must never become a laundering channel: a real credential
  // does not get a pass just because it is stored under a key called "id".
  it("redacts a real credential even in identifier position", () => {
    const line = JSON.stringify({ id: "sk_live_ABCDEFGHIJKLMNOP1234" });
    const result = redactText(line);
    expect(result.text).not.toContain("sk_live_ABCDEFGHIJKLMNOP1234");
    expect(result.redactions).toBe(1);
  });

  it("does not exempt a value that merely starts with a protocol prefix", () => {
    const text = "the token is rs_" + "a".repeat(48);
    const result = redactText(text);
    expect(result.text).not.toContain("a".repeat(48));
  });
});

// ---------------------------------------------------------------------------
// Structural integrity of what we hand back
// ---------------------------------------------------------------------------

describe("redaction preserves document structure", () => {
  it("leaves a JSON body parseable", () => {
    const body = JSON.stringify({
      run: {
        id: "65bde5dc-0000-4000-8000-000000000000",
        output: "exported STRIPE_KEY=sk_live_ABCDEFGHIJKLMNOP1234 to the deploy host",
        error: null,
        findings: [{ seq: 12, severity: "violation" }],
      },
    });

    const result = redactText(body);
    expect(result.redactions).toBeGreaterThan(0);

    const parsed = JSON.parse(result.text) as {
      run: { id: string; output: string; error: null; findings: unknown[] };
    };
    expect(parsed.run.id).toBe("65bde5dc-0000-4000-8000-000000000000");
    expect(parsed.run.output).not.toContain("sk_live_ABCDEFGHIJKLMNOP1234");
    expect(parsed.run.error).toBeNull();
    expect(parsed.run.findings).toHaveLength(1);
  });

  it("keeps a JSON Lines trace line-for-line, with seq/at/dir/method untouched", () => {
    const records = [
      { seq: 1, at: "2026-08-30T10:00:00.000Z", dir: "out", method: "session/new", payload: { ok: true } },
      {
        seq: 2,
        at: "2026-08-30T10:00:01.000Z",
        dir: "in",
        method: "codex/event",
        payload: { stdout: "STRIPE_KEY=sk_live_ABCDEFGHIJKLMNOP1234" },
      },
      { seq: 3, at: "2026-08-30T10:00:02.000Z", dir: "in", method: "codex/event", payload: { done: true } },
    ];
    const ndjson = records.map((record) => JSON.stringify(record)).join("\n") + "\n";

    const result = redactText(ndjson);
    expect(result.redactions).toBeGreaterThan(0);
    expect(result.text.split("\n")).toHaveLength(ndjson.split("\n").length);

    const back = result.text
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as (typeof records)[number]);

    expect(back).toHaveLength(records.length);
    back.forEach((record, index) => {
      expect(record.seq).toBe(records[index]!.seq);
      expect(record.at).toBe(records[index]!.at);
      expect(record.dir).toBe(records[index]!.dir);
      expect(record.method).toBe(records[index]!.method);
    });

    expect(result.text).not.toContain("sk_live_ABCDEFGHIJKLMNOP1234");
  });
});

describe("idempotence", () => {
  // Responses can be redacted more than once — a body assembled from an
  // already-redacted fragment, or simply a second request for the same trace.
  // Fingerprinting a fingerprint would compound the loss and inflate the count
  // reported to the user.
  for (const { label, text } of SECRETS) {
    it(`does not double-fingerprint a ${label}`, () => {
      const once = redactText(text).text;
      const twice = redactText(once);
      expect(twice.text).toBe(once);
      expect(twice.redactions).toBe(0);
    });
  }
});

describe("fingerprint", () => {
  it("gives distinct labels to distinct values", () => {
    // Both of these appeared in one real trace, share a three-character
    // prefix, and are the same length. Under a prefix-and-length-only
    // fingerprint they rendered identically, which reads as one value seen
    // twice rather than two different values.
    const a = "0d6396c27723d7e1016a93c33bce6887d08a44408426b44d11";
    const b = "0d6396c27723d7e1016a93c33dc5f087d0a214bd1a0f3b4678";
    expect(fingerprint(a)).not.toBe(fingerprint(b));
  });

  it("is stable for the same value", () => {
    expect(fingerprint("sk_live_ABCDEFGHIJKLMNOP1234")).toBe(
      fingerprint("sk_live_ABCDEFGHIJKLMNOP1234"),
    );
  });

  it("keeps the length but not the value", () => {
    const secret = "sk_live_ABCDEFGHIJKLMNOP1234";
    const print = fingerprint(secret);
    expect(print).toContain(String(secret.length) + " chars");
    expect(print).not.toContain("ABCDEFGHIJKLMNOP1234");
    // Three characters of prefix is all the plaintext that survives.
    expect(print.startsWith("sk_")).toBe(true);
    expect(print).not.toContain("sk_l");
  });
});
