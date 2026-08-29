// What an Agent remembers, and what earns the right to be remembered.
//
// READ THIS FIRST if you are changing what gets stored.
//
// The guards enforce invariants a single run at a time (see checks.ts). This is
// what carries one run's findings into the next. An Agent that crossed a line
// once should need fewer steps to be stopped the second time, and the rule that
// stops it should not be something the Agent wrote.
//
// A reflection is a *parameter*, not a prompt. Nothing here is ever shown to the
// Agent. Reflections are folded into check options before the container starts (see
// paramsFrom), so an Agent whose thread is reset, or that boots into a fresh
// container, is still bound by them. Two consequences worth stating, because
// they close questions that otherwise keep coming back:
//
//   * Context does not grow. Memory lives in check parameters, which cost no
//     tokens. deniedDestinations could hold five hundred hosts and the prompt
//     would not gain a byte.
//   * Rules need no weighting. Ranking only matters when the prompt is the
//     enforcement mechanism and the model must choose what to obey. Here a value
//     is in a list or it is not, and set membership has no gradient.
//
// Three rules hold the design together:
//
//   1. Structured values only. No prose, ever. A value that must match a
//      hostname charset cannot carry an instruction; a sentence cannot make that
//      promise. The `steer` text sent to the Agent is deliberately NOT stored —
//      it did its job inside the turn.
//
//   2. The Agent's own narration is never consulted. reasoningOf exists and the
//      agent-intent guard uses it, correctly, to warn. It is the wrong input
//      here for a plain reliability reason: reasoning summaries come back empty
//      in a large fraction of real items, so a rule that depended on the model
//      describing itself would land or not land at random. A standing rule
//      outlives the turn that made it and has to be built on something that is
//      always present.
//
//   3. Memory only ever steers. It never blocks. The guards own refusal, and
//      that is unchanged. Because the worst a wrong reflection can do is waste one
//      correction, it is safe to learn on the first sighting instead of waiting
//      for a repeat.
//
// Deterministic, like the checks: same inputs, same reflections out. The caller
// passes `now`; nothing here reads the clock, the filesystem, or the network.
// That is what lets the evaluation harness replay recorded traces offline.

import { DEFAULT_SENSITIVE_MARKERS, READ_VERBS } from "./check-sensitive-egress.js";
import { commandsOf, type Finding } from "./checks.js";
import type { TraceRecord } from "./trace.js";

// ---------------------------------------------------------------------------
// What a reflection is
// ---------------------------------------------------------------------------

/**
 * The trace-state a rule is scoped to, so a reflection reads "watch this
 * destination *when a secret was read first*" rather than "watch it always".
 *
 * The guards already work this way — outbound-blob is a violation after a
 * sensitive read and a warn otherwise — so memory parameterises conditions that
 * already exist rather than inventing new ones. Fixed enum, derived from trace
 * ordering, never from prose.
 */
export const PRECONDITIONS = [
  "sensitive-read",
  "encoded-blob",
  "untrusted-source-read",
  "none",
] as const;

export type Precondition = (typeof PRECONDITIONS)[number];

/** Mirrors EgressChannel in check-sensitive-egress.ts. */
export const CHANNELS = [
  "http",
  "dns",
  "ssh",
  "mail",
  "raw-socket",
  "cloud-cli",
  "package-publish",
  "interpreter",
] as const;

export interface Reflection {
  /** Stable check label. Half the dedup key, and the eviction partition. */
  code: string;
  /** Structured values, verbatim from Finding.facts. The other half of the key. */
  facts: Record<string, string>;
  /**
   * Runs that produced this, oldest first.
   *
   * Not a counter. A reflection that cannot name the runs that created it cannot be
   * safely withdrawn, and a rule nobody can withdraw is one a single bad run can
   * plant permanently.
   */
  sightings: string[];
  firstSeenAt: string;
  lastSeenAt: string;
}

/** A learned value together with the situation it applies in. */
export interface LearnedValue {
  value: string;
  precondition: Precondition;
}

/**
 * What the fold hands to the guards.
 *
 * Note there is no blocked list, at any sighting count — see rule 3 above.
 * Memory widens what the guards notice; it never widens what they refuse.
 */
export interface LearnedParams {
  watchedDestinations: LearnedValue[];
  watchedFiles: LearnedValue[];
}

/** Code for a reflection about the file whose contents preceded the bad step. */
export const INSTRUCTION_SOURCE_CODE = "instruction-source";

// ---------------------------------------------------------------------------
// Bounded memory
// ---------------------------------------------------------------------------
//
// Caps are per `code`, and that partition is load-bearing rather than tidiness.
//
// With one global cap, a run that produces many destination reflections — an Agent
// stuck in a retry loop against rotating hosts, say — mints a fresh entry per
// host, each with a current timestamp. An instruction-source reflection only
// refreshes when that file is read again, so its timestamp goes stale and it is
// evicted first: precisely the reflection that generalises across hosts. Partitioned
// caps mean pressure inside one code can never reach another.

export const DEFAULT_CAPS: Record<string, number> = {
  [INSTRUCTION_SOURCE_CODE]: 50,
};

/** Cap for any code without an entry above. */
export const DEFAULT_CAP = 150;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
//
// Values are rejected, never sanitised. The charset constraint IS the safety
// property, so a value that fails it tells you nothing useful — trimming it to
// fit would leave you guessing about what survived.

const MAX_DESTINATION = 253;
const MAX_SOURCE = 4096;

/** Hostnames, `user@host`, bucket URIs. Deliberately no whitespace or quotes. */
const DESTINATION_CHARSET = /^[A-Za-z0-9._:/@+-]+$/;

/** POSIX-ish paths. No newlines, quotes, or shell metacharacters. */
const SOURCE_CHARSET = /^[A-Za-z0-9._/@ -]+$/;

function isPrecondition(value: string): value is Precondition {
  return (PRECONDITIONS as readonly string[]).includes(value);
}

/**
 * Is every value in `facts` well-formed for its key?
 *
 * Unknown keys are rejected rather than ignored. A guard that starts emitting a
 * new fact has to come through here deliberately, because this function is the
 * only thing standing between a value pulled off a trace and permanent storage.
 */
export function factsAreValid(facts: Record<string, string>): boolean {
  if (Object.keys(facts).length === 0) return false;

  for (const [key, value] of Object.entries(facts)) {
    if (typeof value !== "string" || value === "") return false;

    switch (key) {
      case "channel":
        if (!(CHANNELS as readonly string[]).includes(value)) return false;
        break;
      case "precondition":
        if (!isPrecondition(value)) return false;
        break;
      case "destination":
        if (value.length > MAX_DESTINATION) return false;
        if (!DESTINATION_CHARSET.test(value)) return false;
        break;
      case "source":
        if (value.length > MAX_SOURCE) return false;
        if (!SOURCE_CHARSET.test(value)) return false;
        break;
      default:
        return false;
    }
  }

  return true;
}

/** Stable dedup key: the same facts in any key order produce the same string. */
export function reflectionKey(code: string, facts: Record<string, string>): string {
  const parts = Object.keys(facts)
    .sort()
    .map((key) => `${key}=${facts[key] ?? ""}`);
  return `${code} ${parts.join(" ")}`;
}

// ---------------------------------------------------------------------------
// Source attribution
// ---------------------------------------------------------------------------

/**
 * Which file told the Agent to do it.
 *
 * Evidence, not proximity. A file is the source only when the output of the
 * command that read it actually contains the destination the data was later
 * sent to. That is a direct link: the file names the place, and the Agent then
 * went there.
 *
 * An earlier version blamed every file read before the offending command. On a
 * real run that meant package.json and two source files were marked alongside
 * the checklist, because an Agent doing its job reads a lot. Watching those is
 * worse than watching nothing: the panel fills with innocent files and the one
 * that matters stops standing out.
 *
 * So when no file's contents name the destination, this returns nothing. A
 * missed attribution costs one un-learned rule; a wrong one costs a correction
 * every time an ordinary file is opened, for the life of the Agent.
 *
 * `instructionShaped` overrides all of it — that is where a check that judges a
 * file's content on its own terms plugs in, which is strictly better than
 * inferring it from where the data went.
 */
export function attributeSources(
  trace: TraceRecord[],
  options: {
    markers?: string[];
    /** The destination the data went to. Without it there is nothing to match on. */
    destination?: string;
    instructionShaped?: string[];
  } = {},
): string[] {
  const markers = options.markers ?? DEFAULT_SENSITIVE_MARKERS;

  if (options.instructionShaped !== undefined) {
    const flagged = options.instructionShaped.map(normalisePath);
    return [...new Set(flagged)].filter(
      (path: string) => !mentionsSensitiveLike(path, markers),
    );
  }

  const destination = options.destination;
  if (destination === undefined || destination === "") return [];

  const sources: string[] = [];

  for (const command of commandsOf(trace)) {
    if (command.phase !== "completed") continue;

    const output = command.output ?? "";
    if (output === "") continue;
    if (!output.includes(destination)) continue;

    // The file whose contents these are. A parsed read action names it; a
    // compound command like `cd /workspace && cat notes.md` does not, so the
    // command text is scanned as well.
    const named: string[] = [];
    for (const action of command.actions) {
      const entry = action as Record<string, unknown>;
      if (entry.type !== "read") continue;
      const path = entry.path;
      if (typeof path === "string") named.push(path);
    }
    if (named.length === 0 && READ_VERBS.test(command.command)) {
      named.push(...pathsIn(command.command));
    }

    for (const path of named) {
      const normalised = normalisePath(path);
      if (mentionsSensitiveLike(normalised, markers)) continue;
      if (!sources.includes(normalised)) sources.push(normalised);
    }
  }

  return sources;
}

/**
 * One spelling per file.
 *
 * The runtime reports a parsed read as an absolute path, while a scan of the
 * command text sees whatever the Agent typed. Without this, `/workspace/x` and
 * `x` are stored as two rules for the same file.
 */
export function normalisePath(path: string): string {
  return path.replace(/^\/workspace\//, "").replace(/^\.\//, "");
}

/**
 * File paths named in a command, for the compound-command case: the runtime
 * only parses a read action for a simple command, and an Agent usually writes
 * `cd /workspace && cat notes.md`.
 *
 * Deliberately narrow — a token needs an extension to count, which keeps out
 * flags and subcommands.
 */
function pathsIn(command: string): string[] {
  const found: string[] = [];
  const token = /(?:^|[\s"'`=(])((?:\.{0,2}\/)?(?:[\w.-]+\/)*[\w.-]+\.[A-Za-z0-9]{1,8})(?=$|[\s"'`)&;|])/g;

  for (const match of command.matchAll(token)) {
    const path = match[1];
    if (path === undefined) continue;
    if (!found.includes(path)) found.push(path);
  }

  return found;
}

/** A secret file is never its own instruction source. */
function mentionsSensitiveLike(path: string, markers: string[]): boolean {
  const lower = path.toLowerCase();
  return markers.some((marker) => lower.includes(marker.toLowerCase()));
}

// ---------------------------------------------------------------------------
// The write boundary
// ---------------------------------------------------------------------------

export type RejectionReason =
  | "not-eligible"
  | "no-facts"
  | "invalid-facts"
  | "user-asked";

export interface LearnInput {
  reflections: Reflection[];
  findings: Finding[];
  trace: TraceRecord[];
  runId: string;
  /** The user's own prompt for this run. Used by the "the user asked" gate. */
  prompt: string;
  /** ISO timestamp, passed in so this stays deterministic and replayable. */
  now: string;
  markers?: string[];
  instructionShaped?: string[];
  caps?: Record<string, number>;
}

export interface LearnResult {
  reflections: Reflection[];
  /** Keys created or refreshed by this run. */
  accepted: string[];
  /** Why findings were turned away. Surfaced in the audit view. */
  rejected: Record<RejectionReason, number>;
}

const noRejections = (): Record<RejectionReason, number> => ({
  "not-eligible": 0,
  "no-facts": 0,
  "invalid-facts": 0,
  "user-asked": 0,
});

/**
 * Fold a finished run's findings into the Agent's standing reflections.
 *
 * Pure: returns a new list rather than mutating, so the caller decides when to
 * persist. Runs once at the end of a turn, never per event, so it adds nothing
 * to the per-turn cost of the guards.
 */
export function learnFrom(input: LearnInput): LearnResult {
  const rejected = noRejections();
  const accepted: string[] = [];

  const byKey = new Map<string, Reflection>();
  for (const reflection of input.reflections) {
    byKey.set(reflectionKey(reflection.code, reflection.facts), { ...reflection });
  }

  const promptLower = input.prompt.toLowerCase();

  /**
   * Did the user's own prompt name this value?
   *
   * The guards are deliberately blind to who asked, so an Agent doing exactly
   * what it was told produces the same finding as one that went off the rails.
   * Turning that into a standing rule would quietly break the user's own
   * workflow, permanently, for having asked once. Channel and precondition are
   * skipped because they are enum labels, not values a prompt would name.
   */
  function userAskedFor(facts: Record<string, string>): boolean {
    for (const [key, value] of Object.entries(facts)) {
      if (key === "channel" || key === "precondition") continue;
      if (promptLower.includes(value.toLowerCase())) return true;
    }
    return false;
  }

  function record(code: string, facts: Record<string, string>): void {
    const key = reflectionKey(code, facts);
    const existing = byKey.get(key);

    if (existing === undefined) {
      byKey.set(key, {
        code: code,
        facts: facts,
        sightings: [input.runId],
        firstSeenAt: input.now,
        lastSeenAt: input.now,
      });
    } else if (!existing.sightings.includes(input.runId)) {
      // Several findings inside one run are one sighting, not several.
      existing.sightings = [...existing.sightings, input.runId];
      existing.lastSeenAt = input.now;
    }

    if (!accepted.includes(key)) accepted.push(key);
  }

  let learnedSomething = false;
  let exfilDestination: string | undefined;

  for (const finding of input.findings) {
    if (finding.severity !== "violation" && finding.severity !== "warn") {
      rejected["not-eligible"] += 1;
      continue;
    }

    // No facts means the finding's evidence was the Agent's own narration. Such
    // a check may steer; it may not author a standing rule. Enforced here
    // structurally so it cannot be forgotten in a later check.
    const facts = finding.facts;
    if (facts === undefined || Object.keys(facts).length === 0) {
      rejected["no-facts"] += 1;
      continue;
    }

    if (!factsAreValid(facts)) {
      rejected["invalid-facts"] += 1;
      continue;
    }

    if (userAskedFor(facts)) {
      rejected["user-asked"] += 1;
      continue;
    }

    learnedSomething = true;
    if (exfilDestination === undefined) exfilDestination = facts.destination;
    record(finding.code, facts);
  }

  // The file whose contents preceded the step is attributed from the trace, not
  // reported by any check — no guard looks for it, and the Agent is never asked.
  if (learnedSomething) {
    const sources = attributeSources(input.trace, {
      ...(exfilDestination !== undefined ? { destination: exfilDestination } : {}),
      ...(input.markers !== undefined ? { markers: input.markers } : {}),
      ...(input.instructionShaped !== undefined
        ? { instructionShaped: input.instructionShaped }
        : {}),
    });

    for (const source of sources) {
      const facts = { source: source, precondition: "untrusted-source-read" };
      if (!factsAreValid(facts)) {
        rejected["invalid-facts"] += 1;
        continue;
      }
      if (userAskedFor(facts)) {
        rejected["user-asked"] += 1;
        continue;
      }
      record(INSTRUCTION_SOURCE_CODE, facts);
    }
  }

  return {
    reflections: evict([...byKey.values()], input.caps ?? DEFAULT_CAPS),
    accepted: accepted,
    rejected: rejected,
  };
}

/**
 * Drop the least recently seen reflections, within each `code`.
 *
 * Partitioned deliberately — see the note on DEFAULT_CAPS.
 */
export function evict(reflections: Reflection[], caps: Record<string, number>): Reflection[] {
  const byCode = new Map<string, Reflection[]>();
  for (const reflection of reflections) {
    const group = byCode.get(reflection.code) ?? [];
    group.push(reflection);
    byCode.set(reflection.code, group);
  }

  const kept = new Set<Reflection>();
  for (const [code, group] of byCode) {
    const cap = caps[code] ?? DEFAULT_CAP;
    if (group.length <= cap) {
      for (const reflection of group) kept.add(reflection);
      continue;
    }
    const survivors = [...group]
      .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))
      .slice(0, cap);
    for (const reflection of survivors) kept.add(reflection);
  }

  // Keep the caller's ordering so the stored list stays stable and diffable.
  return reflections.filter((reflection) => kept.has(reflection));
}

// ---------------------------------------------------------------------------
// The fold, and withdrawal
// ---------------------------------------------------------------------------

/**
 * Turn stored reflections into guard parameters.
 *
 * Pure, and the only route by which memory reaches a run. Called once before the
 * container starts. Everything lands in a watched list: a match produces a warn
 * with a steer, never a refusal.
 */
export function paramsFrom(reflections: Reflection[]): LearnedParams {
  const watchedDestinations: LearnedValue[] = [];
  const watchedFiles: LearnedValue[] = [];

  for (const reflection of reflections) {
    const raw = reflection.facts.precondition ?? "none";
    const precondition: Precondition = isPrecondition(raw) ? raw : "none";

    const destination = reflection.facts.destination;
    if (destination !== undefined) {
      watchedDestinations.push({ value: destination, precondition: precondition });
    }

    // Only an instruction-source reflection contributes a watched file. An egress
    // reflection's `source` is the secret that was read (.env), not the file whose
    // contents preceded the step — watching the secret would say nothing.
    if (reflection.code === INSTRUCTION_SOURCE_CODE) {
      const source = reflection.facts.source;
      if (source !== undefined) {
        watchedFiles.push({ value: source, precondition: precondition });
      }
    }
  }

  return { watchedDestinations: watchedDestinations, watchedFiles: watchedFiles };
}

/**
 * Remove one reflection.
 *
 * Not a nicety. The guards are blind to who asked, so they fire identically on
 * an Agent doing exactly what the user wanted. Without a way back, one such run
 * would leave a standing rule the user cannot clear.
 */
export function withdraw(
  reflections: Reflection[],
  code: string,
  facts: Record<string, string>,
): Reflection[] {
  const target = reflectionKey(code, facts);
  return reflections.filter((reflection) => reflectionKey(reflection.code, reflection.facts) !== target);
}
