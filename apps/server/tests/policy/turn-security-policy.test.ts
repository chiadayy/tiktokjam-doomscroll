import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { resolveTurnSecurityPolicy } from "../../src/turn-security-policy.js";

describe("turn security policy", () => {
  it("leaves an unguarded turn at the configured sandbox default", () => {
    const policy = resolveTurnSecurityPolicy(
      loadConfig({ NODE_ENV: "test", CODEX_SANDBOX_MODE: "danger-full-access" }),
    );

    expect(policy).toEqual({
      sandboxMode: "danger-full-access",
      denyNetwork: false,
      semanticEnforcement: false,
      effectGating: false,
    });
  });

  it("uses the verified effect gate for deterministic egress enforcement", () => {
    const policy = resolveTurnSecurityPolicy(
      loadConfig({
        NODE_ENV: "test",
        GUARDRAIL_EGRESS_ENABLED: "true",
        GUARDRAIL_SANDBOX: "workspace-write",
      }),
    );

    expect(policy).toEqual({
      sandboxMode: "read-only",
      denyNetwork: true,
      approvalPolicy: "untrusted",
      semanticEnforcement: false,
      effectGating: true,
    });
  });

  it("uses the verified read-only approval barrier for semantic enforcement", () => {
    const policy = resolveTurnSecurityPolicy(
      loadConfig({
        NODE_ENV: "test",
        GUARDRAIL_SEMANTIC_ENABLED: "true",
        GUARDRAIL_EGRESS_ENABLED: "true",
        GUARDRAIL_SANDBOX: "danger-full-access",
      }),
    );

    expect(policy).toEqual({
      sandboxMode: "read-only",
      denyNetwork: true,
      approvalPolicy: "untrusted",
      semanticEnforcement: true,
      effectGating: true,
    });
  });

  it("uses the effect gate for HITL while leaving semantic enforcement off", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      HITL_ENABLED: "true",
      HITL_TIMEOUT_MS: "120000",
    });
    const policy = resolveTurnSecurityPolicy(config);

    expect(config.hitlEnabled).toBe(true);
    expect(config.hitlTimeoutMs).toBe(120_000);
    expect(policy).toEqual({
      sandboxMode: "read-only",
      denyNetwork: true,
      approvalPolicy: "untrusted",
      semanticEnforcement: false,
      effectGating: true,
    });
  });
});
