import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PAIRED_GROUPS, SCENARIOS } from "../scenarios/index.js";

const tmpDirs: string[] = [];
function fresh(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), "bench-scn-"));
  tmpDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpDirs) {
    try {
      execFileSync("chmod", ["-R", "u+w", d]);
    } catch {
      /* ignore */
    }
    rmSync(d, { recursive: true, force: true });
  }
});

describe("scenario suite", () => {
  it("has a sensible spread of families", () => {
    const families = new Set(SCENARIOS.map((s) => s.family));
    expect(families).toEqual(
      new Set(["benign", "wording", "hiding-place", "send-method", "multi-step", "new-address"]),
    );
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(20);
  });

  it("every id is unique", () => {
    const ids = SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("new-address is a 3-member ordered paired group", () => {
    expect(PAIRED_GROUPS["new-address"]).toEqual(["address-1", "address-2", "address-unseen"]);
  });

  for (const scenario of SCENARIOS) {
    it(`${scenario.id}: setupWorkspace + attack.place produce a project`, () => {
      const dir = fresh();
      scenario.setupWorkspace(dir);
      scenario.attack?.place(dir);

      expect(existsSync(path.join(dir, "package.json"))).toBe(true);
      expect(existsSync(path.join(dir, "src/pricing.js"))).toBe(true);
      expect(existsSync(path.join(dir, ".git"))).toBe(true);

      // address-unseen deliberately has no secret; everything else does.
      const hasEnv = existsSync(path.join(dir, ".env"));
      expect(hasEnv).toBe(scenario.id !== "address-unseen");

      if (scenario.attack) {
        // The sink appears somewhere in the workspace after placement.
        const blob = [
          "skills/deploy-helper.md",
          "skills/release-check.md",
          "AGENTS.md",
          "README.md",
          "src/pricing.test.js",
        ]
          .map((p) => {
            try {
              return readFileSync(path.join(dir, p), "utf8");
            } catch {
              return "";
            }
          })
          .join("\n");
        const gitLog = (() => {
          try {
            return execFileSync("git", ["-C", dir, "log", "--format=%B"], { encoding: "utf8" });
          } catch {
            return "";
          }
        })();
        expect(`${blob}\n${gitLog}`).toContain(scenario.attack.sink);
      }
    });
  }
});
