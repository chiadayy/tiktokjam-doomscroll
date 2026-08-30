import { describe, expect, it } from "vitest";
import { fingerprint } from "./redaction/index.js";
import {
  ModelSemanticIntentMonitor,
  redactSensitiveText,
  type SemanticMonitorInput,
} from "./semantic-intent-monitor.js";

const input: SemanticMonitorInput = {
  checkpoint: "reasoning",
  trustedTask: { userPrompt: "fix validation", agentInstructions: "work carefully" },
  recentReasoning: [{ seq: 2, text: "I will fix the parser." }],
  recentActions: [],
  recentSources: [],
  cheapIntentSignal: false,
};

describe("model semantic intent monitor", () => {
  it("parses and validates a structured Responses API assessment", async () => {
    const monitor = new ModelSemanticIntentMonitor({
      apiKey: "test-key",
      baseUrl: "https://model.example/v1/",
      model: "judge-model",
      timeoutMs: 1_000,
      fetch: async () =>
        new Response(
          JSON.stringify({
            output: [
              {
                content: [
                  {
                    type: "output_text",
                    text: JSON.stringify({
                      riskScore: 0.1,
                      confidence: 0.9,
                      classification: "aligned",
                      apparentObjective: "fix validation",
                      conflictsWithTask: false,
                      evidenceSeqs: [2],
                      rationale: "The proposed objective matches the task.",
                    }),
                  },
                ],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });

    await expect(monitor.assess(input)).resolves.toMatchObject({
      classification: "aligned",
      conflictsWithTask: false,
    });
  });

  it("rejects arbitrary or malformed model output", async () => {
    const monitor = new ModelSemanticIntentMonitor({
      apiKey: "test-key",
      baseUrl: "https://model.example/v1",
      model: "judge-model",
      timeoutMs: 1_000,
      fetch: async () =>
        new Response(JSON.stringify({ output_text: '{"classification":"aligned"}' }), {
          status: 200,
        }),
    });

    await expect(monitor.assess(input)).rejects.toThrow();
  });

  // The expected shape changed here on purpose, and the reason is worth
  // recording. This function used to own private regexes that replaced a
  // secret with a fixed marker (`API_KEY=[REDACTED]`). It now delegates to the
  // shared redaction registry, which substitutes a fingerprint instead.
  //
  // Two things improve. A fingerprint keeps the length, which is diagnostic —
  // `[REDACTED]` cannot distinguish a 20-character key from a 2KB private key
  // body. And redacted output now looks identical everywhere it surfaces: in a
  // finding's message, in the trajectory view, and here. The old markers were
  // a fourth spelling of "we took something out".
  it("redacts credential-shaped values before monitor use", () => {
    expect(redactSensitiveText("API_KEY=abcdefghijklmnop1234")).toBe(
      "API_KEY=" + fingerprint("abcdefghijklmnop1234"),
    );
    expect(redactSensitiveText("Authorization: Bearer secret-value-123")).not.toContain(
      "secret-value-123",
    );
  });
});
