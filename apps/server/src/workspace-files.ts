// Reading and writing the files in an Agent's workspace, for the UI.
//
// Why this exists: a workspace is a directory on the host that only the Agent
// and a terminal ever touched. Everything this project is about starts with a
// file somebody put there — a skill, a checklist, a config — and until now
// there was no way to see or place one without leaving the product.
//
// Two rules shape the whole module:
//
//   * Every path is resolved and checked against the workspace root before it
//     is opened. The path arrives from a browser, so it is attacker-controlled
//     input in the same sense every other input here is. `..` segments and
//     absolute paths are rejected by construction rather than by pattern.
//   * Everything is bounded. A workspace can contain a node_modules tree with
//     a hundred thousand files, and a listing that walks it would hang the
//     request. Caps are constants below, not options, because a caller who
//     could raise them would eventually raise them.
//
// Reading a file does not redact anything here. The redaction hook on the way
// out of the API does that for every JSON response, and doing it in one place
// is what keeps a guard from blocking a credential that the UI then renders.

import { readdir, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

/** Directories never worth listing, and expensive to walk. */
const IGNORED = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".codex",
  ".deleted",
  ".next",
  "coverage",
]);

/** Most files we will report in one listing. */
export const MAX_ENTRIES = 500;

/** Deepest directory nesting we will descend. */
export const MAX_DEPTH = 8;

/** Largest file we will send to the browser to display. */
export const MAX_READ_BYTES = 256 * 1024;

/** Largest file we will accept from the browser. */
export const MAX_WRITE_BYTES = 1024 * 1024;

export interface WorkspaceEntry {
  /** Path relative to the workspace root, POSIX separators. */
  path: string;
  size: number;
  modifiedAt: string;
}

export interface WorkspaceFile {
  path: string;
  content: string;
  size: number;
  /** True when the file was longer than MAX_READ_BYTES and content is a prefix. */
  truncated: boolean;
}

export class WorkspacePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspacePathError";
  }
}

/**
 * Turn a caller-supplied relative path into an absolute one inside `root`.
 *
 * The containment check is done on the resolved path rather than by scanning
 * the input for `..`, because the resolver is the thing that decides where the
 * path actually lands — any check that disagrees with it is the one that is
 * wrong. A trailing separator on the root prevents `/workspace-other` from
 * passing a naive prefix test against `/workspace`.
 */
export function resolveInside(root: string, relative: string): string {
  if (relative.length === 0) {
    throw new WorkspacePathError("A path is required");
  }
  if (relative.includes("\0")) {
    throw new WorkspacePathError("Path contains a null byte");
  }
  if (path.isAbsolute(relative)) {
    throw new WorkspacePathError("Path must be relative to the workspace");
  }

  const rootResolved = path.resolve(root);
  const target = path.resolve(rootResolved, relative);

  if (target !== rootResolved && !target.startsWith(rootResolved + path.sep)) {
    throw new WorkspacePathError("Path is outside the workspace");
  }

  return target;
}

/** Every file in the workspace, breadth-first, bounded. */
export async function listWorkspaceFiles(root: string): Promise<WorkspaceEntry[]> {
  const entries: WorkspaceEntry[] = [];
  // Breadth-first rather than recursive descent: when the cap is reached, what
  // we have is the shallow files — the ones a person is actually looking for —
  // instead of everything under whichever directory happened to sort first.
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

  while (queue.length > 0 && entries.length < MAX_ENTRIES) {
    const current = queue.shift();
    if (current === undefined) break;

    const contents = await readdir(current.dir, { withFileTypes: true }).catch(() => null);
    if (contents === null) continue;

    for (const item of contents) {
      if (entries.length >= MAX_ENTRIES) break;
      if (IGNORED.has(item.name)) continue;

      const absolute = path.join(current.dir, item.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");

      if (item.isDirectory()) {
        if (current.depth < MAX_DEPTH) queue.push({ dir: absolute, depth: current.depth + 1 });
        continue;
      }
      if (!item.isFile()) continue;

      const info = await stat(absolute).catch(() => null);
      if (info === null) continue;

      entries.push({
        path: relative,
        size: info.size,
        modifiedAt: info.mtime.toISOString(),
      });
    }
  }

  entries.sort((a, b) => a.path.localeCompare(b.path));
  return entries;
}

/** One file's contents, as text, truncated rather than refused when large. */
export async function readWorkspaceFile(
  root: string,
  relative: string,
): Promise<WorkspaceFile> {
  const absolute = resolveInside(root, relative);

  const info = await stat(absolute);
  if (!info.isFile()) {
    throw new WorkspacePathError("Not a file");
  }

  const buffer = await readFile(absolute);
  const truncated = buffer.byteLength > MAX_READ_BYTES;

  return {
    path: relative.split(path.sep).join("/"),
    content: buffer.subarray(0, MAX_READ_BYTES).toString("utf8"),
    size: info.size,
    truncated: truncated,
  };
}

/**
 * Create or replace a file in the workspace.
 *
 * Parent directories are created, so placing `skills/deploy-helper.md` into a
 * workspace that has no `skills/` works the way a person expects rather than
 * failing on a missing directory they cannot see.
 */
export async function writeWorkspaceFile(
  root: string,
  relative: string,
  content: string,
): Promise<WorkspaceEntry> {
  const absolute = resolveInside(root, relative);

  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_WRITE_BYTES) {
    throw new WorkspacePathError(
      `File is ${bytes} bytes; the limit is ${MAX_WRITE_BYTES}`,
    );
  }

  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, content, "utf8");

  const info = await stat(absolute);
  return {
    path: relative.split(path.sep).join("/"),
    size: info.size,
    modifiedAt: info.mtime.toISOString(),
  };
}
