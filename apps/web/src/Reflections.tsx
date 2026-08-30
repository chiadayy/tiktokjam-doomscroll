// What this Agent has been stopped for before, and what the guards reported on
// the run you are looking at.
//
// Two panels, because they answer two different questions. "What has it learned"
// is a property of the Agent and survives every run. "What happened this time"
// is a property of one run. Seeing them side by side is what makes the second
// run legible: a warning fired here *because* of something in the panel above.
//
// A reflection is stored as values, never as prose, so this renders fields
// rather than sentences. That is not a display choice — nothing the model wrote
// is kept, so there is no sentence to show.

import type { Finding, Reflection } from "./types";

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
    <section className="reflections">
      <header className="reflections-head">
        <strong>What this Agent has learned</strong>
        <span className="reflections-count">
          {reflections.length === 0
            ? "nothing yet"
            : `${reflections.length} rule${reflections.length === 1 ? "" : "s"}`}
        </span>
      </header>

      {reflections.length === 0 ? (
        <p className="reflections-empty">
          This Agent has not been stopped for anything yet. Rules appear here after a guard
          catches something, and apply to every later run — including in a fresh container.
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
    </section>
  );
}

const SEVERITY_LABEL: Record<Finding["severity"], string> = {
  violation: "refused",
  warn: "warning",
  info: "noted",
};

export function FindingList({ findings }: { findings: Finding[] }) {
  if (findings.length === 0) return null;

  return (
    <section className="findings">
      <header className="findings-head">
        <strong>Guards on this run</strong>
      </header>
      <ul className="finding-items">
        {findings.map((finding) => (
          <li
            className={`finding-item finding-${finding.severity}`}
            key={`${finding.check}:${finding.code}:${finding.seq}`}
          >
            <div className="finding-top">
              <span className="finding-badge">{SEVERITY_LABEL[finding.severity]}</span>
              <code>{finding.code}</code>
              {finding.check === "learned-watch" && (
                <span className="finding-learned">from an earlier run</span>
              )}
            </div>
            <p className="finding-message">{finding.message}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
