// The files an Agent can see, and a way to put one there.
//
// Why this exists: every scenario this project guards against starts with a
// file somebody placed in the workspace — a skill, a runbook, a checklist
// copied from somewhere. That file is the most important input to the whole
// system, and until now it could only be placed from a terminal. A user of the
// product could not see what their Agent was reading, let alone add to it.
//
// Two things this panel deliberately does *not* do:
//
//   * It does not hide sensitive files. Seeing that `.env` sits next to a skill
//     that mentions it is the entire point. The API redacts credential-shaped
//     values on the way out, so the file can be shown without the secret being
//     rendered — which is also why the badge says "watched", not "hidden".
//   * It does not warn about what you type. The guards run on what the Agent
//     does, not on what a person writes, and a linter here would imply the
//     protection lives in the editor. It does not.

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "./api";
import type { Reflection, WorkspaceEntry, WorkspaceFile } from "./types";

/**
 * Filename fragments the egress guard treats as a credential read.
 *
 * Mirrors DEFAULT_SENSITIVE_MARKERS on the server. Kept as a display hint only
 * — nothing here changes what is guarded, so drift costs a badge, never a
 * decision.
 */
const SENSITIVE_HINTS = [".env", "credentials", "secrets", ".pem", "id_rsa", ".netrc"];

/** Files whose name marks them as a template, not a real credential store. */
const TEMPLATE_HINT = /\.(example|sample|template|dist|tpl)$/i;

function isSensitive(path: string): boolean {
  const lower = path.toLowerCase();
  if (TEMPLATE_HINT.test(lower)) return false;
  return SENSITIVE_HINTS.some((hint) => lower.includes(hint));
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

/** Paths this Agent has been stopped over before, from its reflections. */
function watchedFiles(reflections: Reflection[]): Set<string> {
  const paths = new Set<string>();
  for (const reflection of reflections) {
    const source = reflection.facts.source;
    if (source !== undefined) paths.add(source.replace(/^\/workspace\//, ""));
  }
  return paths;
}

export function Workspace({
  agentId,
  reflections,
  onClose,
}: {
  agentId: string;
  reflections: Reflection[];
  onClose: () => void;
}) {
  const [files, setFiles] = useState<WorkspaceEntry[]>([]);
  const [open, setOpen] = useState<WorkspaceFile | null>(null);
  const [draftPath, setDraftPath] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const watched = watchedFiles(reflections);

  const refresh = useCallback(async () => {
    try {
      const result = await api.workspace(agentId);
      setFiles(result.files);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Could not list the workspace");
    }
  }, [agentId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openFile = useCallback(
    async (path: string) => {
      setError(null);
      setEditing(false);
      try {
        const result = await api.workspaceFile(agentId, path);
        setOpen(result.file);
      } catch (cause) {
        setError(cause instanceof ApiError ? cause.message : "Could not read that file");
      }
    },
    [agentId],
  );

  const startNew = () => {
    setOpen(null);
    setEditing(true);
    setDraftPath("skills/");
    setDraftBody("");
    setError(null);
    setSaved(null);
  };

  const startEdit = () => {
    if (open === null) return;
    setEditing(true);
    setDraftPath(open.path);
    setDraftBody(open.content);
    setSaved(null);
  };

  const save = async () => {
    const path = draftPath.trim();
    if (path.length === 0) {
      setError("Give the file a path");
      return;
    }
    // The field pre-fills with a directory prefix, so this is the easy mistake:
    // saving `skills/` would name a file `skills` and block the directory.
    if (path.endsWith("/")) {
      setError("Add a file name after the folder, e.g. skills/deploy-helper.md");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.saveWorkspaceFile(agentId, path, draftBody);
      await refresh();
      await openFile(path);
      setSaved(path);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Could not save that file");
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="workspace-panel" aria-label="Agent workspace">
      <div className="workspace-head">
        <div>
          <span className="eyebrow">Workspace</span>
          <h2>What the Agent can read</h2>
        </div>
        <div className="workspace-head-actions">
          <button className="button button-ghost" onClick={startNew}>
            Add a file
          </button>
          <button onClick={onClose} aria-label="Close workspace panel">
            ×
          </button>
        </div>
      </div>

      {error !== null && (
        <p className="workspace-error" role="alert">
          {error}
        </p>
      )}

      <div className="workspace-body">
        <ul className="workspace-tree">
          {files.length === 0 && <li className="workspace-empty">No files yet.</li>}
          {files.map((file) => (
            <li key={file.path}>
              <button
                className={"workspace-file" + (open?.path === file.path ? " is-open" : "")}
                onClick={() => void openFile(file.path)}
              >
                <span className="workspace-file-path">{file.path}</span>
                <span className="workspace-file-meta">
                  {watched.has(file.path) && (
                    <span
                      className="workspace-badge workspace-badge-watched"
                      title="This Agent has been stopped over this file before"
                    >
                      watched
                    </span>
                  )}
                  {isSensitive(file.path) && (
                    <span
                      className="workspace-badge workspace-badge-sensitive"
                      title="The egress guard treats reading this as a credential read"
                    >
                      sensitive
                    </span>
                  )}
                  <span className="workspace-size">{formatSize(file.size)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>

        <div className="workspace-view">
          {editing ? (
            <div className="workspace-editor">
              <label className="workspace-path-field">
                Path
                <input
                  value={draftPath}
                  onChange={(event) => setDraftPath(event.target.value)}
                  placeholder="skills/deploy-helper.md"
                  spellCheck={false}
                />
              </label>
              <textarea
                className="workspace-textarea"
                value={draftBody}
                onChange={(event) => setDraftBody(event.target.value)}
                spellCheck={false}
                rows={18}
                placeholder={"# deploy-helper\n\n## 1. Check the build\n\nRun the tests."}
              />
              <div className="workspace-editor-actions">
                <button
                  className="button button-ghost"
                  onClick={() => setEditing(false)}
                  disabled={busy}
                >
                  Cancel
                </button>
                <button className="button button-primary" onClick={() => void save()} disabled={busy}>
                  {busy ? "Saving…" : "Save to workspace"}
                </button>
              </div>
              <p className="workspace-note">
                Saved straight into the Agent&apos;s workspace. Nothing here is checked — the
                guards run on what the Agent <em>does</em> with it, on the next run.
              </p>
            </div>
          ) : open !== null ? (
            <>
              <div className="workspace-view-head">
                <code>{open.path}</code>
                <button className="button button-ghost" onClick={startEdit}>
                  Edit
                </button>
              </div>
              {saved === open.path && (
                <p className="workspace-saved">Saved. The Agent will see this on its next run.</p>
              )}
              <pre className="workspace-content">{open.content}</pre>
              {open.truncated && (
                <p className="workspace-note">
                  Showing the first 256 KB of {formatSize(open.size)}.
                </p>
              )}
            </>
          ) : (
            <p className="workspace-placeholder">
              Pick a file to read it, or add one for the Agent to find.
            </p>
          )}
        </div>
      </div>
    </aside>
  );
}
