// The "defenses" axis: which GUARDRAIL_* flags are on for a cell. Analogous to
// AgentDojo's defense presets (delimiters / sandwiching / detector / …).

import type { GuardConfig } from "./types.js";

const ON = "true";

export const GUARD_CONFIGS: Record<string, GuardConfig> = {
  off: { name: "off", env: {} },
  egress: { name: "egress", env: { GUARDRAIL_EGRESS_ENABLED: ON } },
  "egress+intent": {
    name: "egress+intent",
    env: { GUARDRAIL_EGRESS_ENABLED: ON, GUARDRAIL_INTENT_ENABLED: ON },
  },
  "egress+reflection": {
    name: "egress+reflection",
    env: { GUARDRAIL_EGRESS_ENABLED: ON, GUARDRAIL_REFLECTION_ENABLED: ON },
  },
  semantic: { name: "semantic", env: { GUARDRAIL_SEMANTIC_ENABLED: ON } },
  all: {
    name: "all",
    env: {
      GUARDRAIL_EGRESS_ENABLED: ON,
      GUARDRAIL_INTENT_ENABLED: ON,
      GUARDRAIL_REFLECTION_ENABLED: ON,
      GUARDRAIL_SEMANTIC_ENABLED: ON,
    },
  },
};

export function parseGuardConfigs(csv: string): GuardConfig[] {
  const names = csv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const out: GuardConfig[] = [];
  for (const name of names) {
    const preset = GUARD_CONFIGS[name];
    if (!preset) {
      throw new Error(
        `unknown guard config "${name}". known: ${Object.keys(GUARD_CONFIGS).join(", ")}`,
      );
    }
    out.push(preset);
  }
  return out;
}
