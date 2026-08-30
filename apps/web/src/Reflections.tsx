// What this Agent has been stopped for before. This is Agent-level state, so it
// lives by the Agent header rather than inside an individual conversation.
//
// A reflection is stored as values, never as prose, so this renders fields
// rather than sentences. That is not a display choice — nothing the model wrote
// is kept, so there is no sentence to show.

import type { Reflection } from "./types";

/** Plain-language description of what a reflection watches. */
function subjectOf(reflection: Reflection): { label: string; value: string } {
  const destination = reflection.facts.destination;
  if (destination !== undefined) {
    return { label: "destination", value: destination };
  }

  const source = reflection.facts.source;
  if (source !== undefined) {
    return { label: "file", value: source };
  }

  return { label: reflection.code, value: "—" };
}

const WHEN: Record<string, string> = {
  "sensitive-read": "after a secret is read",
  "encoded-blob": "when the payload is encoded",
  "untrusted-source-read": "whenever it is read",
  none: "always",
};

export function ReflectionList({ reflections }: { reflections: Reflection[] }) {
  return (
    <details className="reflections safety-memory">
      <summary>
        <strong>Safety memory</strong>
        <span aria-hidden="true">·</span>
        <span>{reflections.length}</span>
      </summary>

      {reflections.length === 0 ? (
        <p className="reflections-empty">
          No persistent safety lessons yet.
        </p>
      ) : (
        <ul className="reflection-items">
          {reflections.map((reflection) => {
            const subject = subjectOf(reflection);
            const when = WHEN[reflection.facts.precondition ?? "none"] ?? "always";
            const seen = reflection.sightings.length;
            // Mirrors tierOf on the server. An absent list predates thread
            // tracking and counts as recurring, so an upgrade never demotes.
            const conversations = reflection.threads?.length;
            const recurring = conversations === undefined || conversations >= 2;
            const needsAttention = conversations !== undefined && conversations >= 3;

            return (
              <li className="reflection-item" key={`${reflection.code}:${subject.value}:${when}`}>
                <div className="reflection-subject">
                  <span className="reflection-kind">watch {subject.label}</span>
                  <code>{subject.value}</code>
                  {recurring && (
                    <span className="reflection-tier" title="Seen in more than one conversation">
                      recurring
                    </span>
                  )}
                  {needsAttention && (
                    <span
                      className="reflection-attention"
                      title="This Agent has been stopped here in three separate conversations. Steering it again is unlikely to help."
                    >
                      needs a look
                    </span>
                  )}
                </div>
                <div className="reflection-meta">
                  <span>{when}</span>
                  <span aria-hidden="true">·</span>
                  <span>
                    seen in {seen} run{seen === 1 ? "" : "s"}
                  </span>
                  {conversations !== undefined && conversations > 1 && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span>across {conversations} conversations</span>
                    </>
                  )}
                  {reflection.facts.channel !== undefined && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span>over {reflection.facts.channel}</span>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <p className="reflections-note">
        Stored as guard settings, not as text in the prompt — so they cost no tokens and the
        Agent is never asked to agree to them.
      </p>
    </details>
  );
}
