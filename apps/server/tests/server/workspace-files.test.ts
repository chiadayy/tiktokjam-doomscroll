// The workspace file API is reachable from a browser, so every path it is
// handed is untrusted input. These tests are mostly about the one property
// that matters: nothing outside the workspace root can be read or written, no
// matter how the path is spelled.

import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  listWorkspaceFiles,
  readWorkspaceFile,
  writeWorkspaceFile,
  resolveInside,
  WorkspacePathError,
  MAX_ENTRIES,
} from "../../src/workspace-files.js";

async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "ws-"));
  await mkdir(path.join(root, "skills"), { recursive: true });
  await mkdir(path.join(root, "node_modules", "left-pad"), { recursive: true });
  await writeFile(path.join(root, "AGENTS.md"), "# agent\n", "utf8");
  await writeFile(path.join(root, ".env"), "STRIPE_SECRET_KEY=sk_live_abc\n", "utf8");
  await writeFile(path.join(root, "skills", "deploy.md"), "# deploy\n", "utf8");
  await writeFile(path.join(root, "node_modules", "left-pad", "index.js"), "x", "utf8");
  return root;
}

describe("workspace listing", () => {
  it("lists workspace files with sizes", async () => {
    const root = await workspace();
    const files = await listWorkspaceFiles(root);
    const paths = files.map((file) => file.path);

    expect(paths).toContain("AGENTS.md");
    expect(paths).toContain(".env");
    expect(paths).toContain("skills/deploy.md");
    expect(files.every((file) => file.size >= 0)).toBe(true);
  });

  it("skips node_modules and other noise", async () => {
    const root = await workspace();
    const paths = (await listWorkspaceFiles(root)).map((file) => file.path);

    expect(paths.some((entry) => entry.startsWith("node_modules"))).toBe(false);
  });

  it("stops at the entry cap rather than walking a huge tree", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ws-big-"));
    await Promise.all(
      Array.from({ length: MAX_ENTRIES + 40 }, (_, index) =>
        writeFile(path.join(root, "file-" + index + ".txt"), "x", "utf8"),
      ),
    );

    const files = await listWorkspaceFiles(root);
    expect(files.length).toBe(MAX_ENTRIES);
  });
});

describe("workspace path containment", () => {
  // The guard is the resolved path, not a scan for "..", so these are spelled
  // several different ways on purpose.
  const escapes = [
    "../outside.txt",
    "../../etc/passwd",
    "skills/../../outside.txt",
    "./../../outside.txt",
  ];

  it.each(escapes)("refuses to resolve %s", async (attempt) => {
    const root = await workspace();
    expect(() => resolveInside(root, attempt)).toThrow(WorkspacePathError);
  });

  it("refuses an absolute path", async () => {
    const root = await workspace();
    expect(() => resolveInside(root, "/etc/passwd")).toThrow(WorkspacePathError);
  });

  it("refuses a path containing a null byte", async () => {
    const root = await workspace();
    expect(() => resolveInside(root, "a\0b")).toThrow(WorkspacePathError);
  });

  it("does not treat a sibling directory as inside the workspace", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "ws-sib-"));
    const root = path.join(parent, "agent");
    await mkdir(root, { recursive: true });
    await mkdir(path.join(parent, "agent-other"), { recursive: true });

    // A naive startsWith check without the separator would let this through.
    expect(() => resolveInside(root, "../agent-other/secret.txt")).toThrow(
      WorkspacePathError,
    );
  });

  it("allows an ordinary nested path", async () => {
    const root = await workspace();
    expect(resolveInside(root, "skills/deploy.md")).toBe(
      path.join(path.resolve(root), "skills", "deploy.md"),
    );
  });

  it("refuses to read outside the workspace", async () => {
    const root = await workspace();
    await expect(readWorkspaceFile(root, "../outside.txt")).rejects.toThrow(
      WorkspacePathError,
    );
  });

  it("refuses to write outside the workspace", async () => {
    const root = await workspace();
    await expect(writeWorkspaceFile(root, "../escaped.md", "nope")).rejects.toThrow(
      WorkspacePathError,
    );
  });
});

describe("workspace reading", () => {
  it("reads a file's contents", async () => {
    const root = await workspace();
    const file = await readWorkspaceFile(root, "skills/deploy.md");

    expect(file.content).toBe("# deploy\n");
    expect(file.truncated).toBe(false);
  });

  it("does not redact — that is the API layer's job, in one place", async () => {
    const root = await workspace();
    const file = await readWorkspaceFile(root, ".env");

    // A second redactor here would be a second list to keep in sync, which is
    // exactly the failure the redaction module exists to prevent.
    expect(file.content).toContain("sk_live_abc");
  });

  it("truncates a file past the read cap instead of refusing it", async () => {
    const root = await workspace();
    await writeFile(path.join(root, "big.txt"), "a".repeat(300 * 1024), "utf8");

    const file = await readWorkspaceFile(root, "big.txt");
    expect(file.truncated).toBe(true);
    expect(file.content.length).toBeLessThan(file.size);
  });
});

describe("workspace writing", () => {
  it("creates a file the Agent will read", async () => {
    const root = await workspace();
    await writeWorkspaceFile(root, "skills/new-skill.md", "# hello\n");

    const written = await readFile(path.join(root, "skills", "new-skill.md"), "utf8");
    expect(written).toBe("# hello\n");
  });

  it("creates missing parent directories", async () => {
    const root = await workspace();
    await writeWorkspaceFile(root, "a/b/c/deep.md", "deep\n");

    const written = await readFile(path.join(root, "a", "b", "c", "deep.md"), "utf8");
    expect(written).toBe("deep\n");
  });

  it("overwrites an existing file", async () => {
    const root = await workspace();
    await writeWorkspaceFile(root, "AGENTS.md", "replaced\n");

    expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).toBe("replaced\n");
  });

  it("refuses a file past the write cap", async () => {
    const root = await workspace();
    await expect(
      writeWorkspaceFile(root, "huge.md", "a".repeat(2 * 1024 * 1024)),
    ).rejects.toThrow(WorkspacePathError);
  });
});
