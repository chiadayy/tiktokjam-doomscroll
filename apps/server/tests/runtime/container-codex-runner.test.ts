import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import {
  buildContainerRunArgs,
  buildGuardChecks,
  containerName,
} from "../../src/container-codex-runner.js";

describe("Container Codex runner", () => {
  it("builds an isolated Docker/Podman-compatible invocation", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      ARK_API_KEY: "secret-that-must-not-appear-in-argv",
      ARK_MODEL: "ep-test",
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
      CONTAINER_ENGINE: "podman",
      CONTAINER_RUNTIME_IMAGE: "runtime:test",
      CONTAINER_USER: "501:20",
      RUNTIME_INSTANCE_ID: "test-instance",
    });
    const args = buildContainerRunArgs(
      {
        agentId: "agent/unsafe",
        workspacePath: "/tmp/agent-workspace",
        prompt: "write a small program",
        threadId: null,
      },
      config,
    );

    expect(containerName("agent/unsafe", "test-instance")).toBe(
      "launchpad-test-instance-agent-unsafe",
    );
    expect(args).toContain("runtime:test");
    expect(args).toContain("type=bind,src=/tmp/agent-workspace,dst=/workspace");
    expect(args).toContain("type=bind,src=/tmp/codex-home,dst=/codex-home");
    expect(args).toContain("501:20");
    expect(args).toContain("/workspace");
    expect(args).toContain("io.codejam.instance-id=test-instance");
    expect(args).toContain("keep-id");
    expect(args).not.toContain("secret-that-must-not-appear-in-argv");
  });

  it("launches app-server, not exec, so the turn can be intercepted", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
    });
    const args = buildContainerRunArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "continue",
        threadId: "thread-123",
      },
      config,
    );

    // `exec` hardcodes approval_policy=Never and closes stdin: no interception.
    expect(args).not.toContain("exec");
    expect(args.slice(-4)).toEqual(["codex", "app-server", "--listen", "stdio://"]);

    // Without --interactive the container gets no stdin and JSON-RPC is one-way.
    expect(args).toContain("--interactive");

    // The prompt and thread now travel as JSON-RPC params, never as argv.
    expect(args).not.toContain("continue");
    expect(args).not.toContain("thread-123");
    expect(args).not.toContain("keep-id");
  });
});

describe("buildGuardChecks", () => {
  it("returns no checks when the egress guard flag is unset", () => {
    const config = loadConfig({ NODE_ENV: "test" });
    expect(buildGuardChecks(config)).toEqual([]);
  });

  it("adds the learned-watch check when the reflection guard is on and the Agent has reflections", () => {
    const config = loadConfig({ NODE_ENV: "test", GUARDRAIL_REFLECTION_ENABLED: "true" });
    const reflections = [
      {
        code: "instruction-source",
        facts: { source: "/workspace/skills/deploy-helper.md", precondition: "none" },
        sightings: ["run-1"],
        firstSeenAt: "2026-08-29T00:00:00.000Z",
        lastSeenAt: "2026-08-29T00:00:00.000Z",
      },
    ];

    expect(buildGuardChecks(config, reflections).map((check) => check.name)).toEqual([
      "learned-watch",
    ]);
  });

  it("adds nothing when the reflection guard is on but the Agent has learned nothing yet", () => {
    const config = loadConfig({ NODE_ENV: "test", GUARDRAIL_REFLECTION_ENABLED: "true" });
    expect(buildGuardChecks(config, [])).toEqual([]);
  });

  it("ignores stored reflections while the reflection guard is off", () => {
    const config = loadConfig({ NODE_ENV: "test" });
    const reflections = [
      {
        code: "instruction-source",
        facts: { source: "/workspace/skills/deploy-helper.md", precondition: "none" },
        sightings: ["run-1"],
        firstSeenAt: "2026-08-29T00:00:00.000Z",
        lastSeenAt: "2026-08-29T00:00:00.000Z",
      },
    ];

    expect(buildGuardChecks(config, reflections)).toEqual([]);
  });

  it("returns the sensitive-egress family when GUARDRAIL_EGRESS_ENABLED is true", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      GUARDRAIL_EGRESS_ENABLED: "true",
    });
    expect(buildGuardChecks(config).map((check) => check.name)).toEqual([
      "sensitive-egress",
      "outbound-blob",
    ]);
  });

  it("returns only the agent-intent check when just GUARDRAIL_INTENT_ENABLED is true", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      GUARDRAIL_INTENT_ENABLED: "true",
    });
    expect(buildGuardChecks(config).map((check) => check.name)).toEqual(["agent-intent"]);
  });

  it("composes the guards: each flag adds its own checks, independently", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      GUARDRAIL_EGRESS_ENABLED: "true",
      GUARDRAIL_INTENT_ENABLED: "true",
    });
    expect(buildGuardChecks(config).map((check) => check.name)).toEqual([
      "sensitive-egress",
      "outbound-blob",
      "agent-intent",
    ]);
  });
});
