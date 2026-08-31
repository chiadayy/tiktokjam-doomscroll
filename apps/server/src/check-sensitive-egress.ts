// The first guard in the family.
//
// Every guard here enforces a behavioural invariant: something the agent must
// never do, no matter what led it there. The cause is not the guard's concern
// and is usually unknowable anyway — a reasoning-loop bug, a bad inference, a
// misread instruction in a file it opened, a panic in a retry loop, or text
// that was injected. The guard only asks whether the agent is about to cross
// the line, not why.
//
// This one's invariant: workspace secrets never leave the machine. A run trips
// it when a command that can reach the network is tied to a secret in one of
// three ways:
//
//   * it names a sensitive path in its own arguments (`curl --data @.env ...`),
//   * it follows an earlier read of a sensitive file (`cat .env` then `curl`),
//   * it carries the literal bytes of a credential that a command earlier in
//     the run printed to its output (`cat .env` -> `curl -H "Bearer sk_live_…"`).
//
// Two ideas keep it from being a simple keyword list:
//
//   * Egress is classified by *capability*, not tool name. `classifyEgress`
//     recognises HTTP, DNS, SSH, mail, raw sockets, cloud-storage CLIs, package
//     publish, and inline interpreters running network code. A short list of
//     capabilities covers a large open set of exfiltration channels.
//   * Value flow is followed *within a run*. Credential-shaped strings seen in
//     one command's output are remembered (as raw values, in a local variable
//     only) and matched against the text of every later command, so an egress
//     that never names the file is still caught.
//
// Deterministic like every check (see checks.ts): same trace in, same findings
// out. It reads only the trace and never touches the filesystem or the network.
//
// Secret hygiene: a raw credential value never leaves this function. Findings,
// steers and evidence carry a fingerprint (`sk_…123727(28 chars)`) and seqs,
// never the value itself.

import {
  commandsOf,
  readsOf,
  type Check,
  type CommandEvent,
  type Finding,
} from "./checks.js";
import type { TraceRecord } from "./trace.js";
// The credential shapes this guard gates on, and the fingerprint it reports
// them with, both live in ./redaction. The direction of that import is
// deliberate and worth a sentence, because the obvious arrangement is the
// opposite one.
//
// This file is the oldest consumer, so it used to own the patterns and
// everyone else imported from it — which quietly made the *detector* the
// authority on what a secret looks like. But detection wants precision (a
// false positive blocks a legitimate agent action) and redaction wants recall
// (a false negative puts a credential on a projector). A single list cannot
// serve both, and when the redactor needed a broader answer the result was a
// second list that drifted from this one.
//
// So the registry moved out and this guard became one of its consumers,
// reading the conservative tier. See ./redaction/patterns.ts.
import {
  DETECTION_PATTERNS,
  fingerprint,
  KEYVAL_PATTERN,
  LONG_BASE64_PATTERN,
} from "./redaction/index.js";

export interface SensitiveEgressOptions {
  /**
   * Substrings that mark a path as sensitive. Matched case-insensitively
   * against both the runtime's parsed read paths and the raw command text.
   */
  sensitiveMarkers: string[];
}

/** Names that almost always mean credentials. Tune per workspace via config. */
export const DEFAULT_SENSITIVE_MARKERS = [
  ".env",
  "id_rsa",
  "id_ed25519",
  ".pem",
  ".ssh/",
  ".aws/credentials",
  "credentials.json",
  "secrets",
  ".npmrc",
  ".git-credentials",
  "service-account",
  ".netrc",
  ".pgpass",
];

/** Shell verbs that pull a file's contents into something the agent can forward. */
export const READ_VERBS =
  /\b(cat|head|tail|less|more|xxd|base64|strings|od|hexdump|nl|cp|mv|tar|zip|gzip|dd)\b/i;

/**
 * Staging a file into version control, which forwards its contents just as
 * surely as `cat` does — only on a delay, and to everyone with clone access.
 *
 * This closes the gap that let `git add -f .env && git commit && git push`
 * through untouched: staging was not a read, and the push never named the
 * secret, so neither half of the read-then-egress rule fired. Confirmed as a
 * live leak against a real Agent before this existed, with the guards on.
 *
 * `-f` matters. A repository that ignores `.env` is the normal case, so an
 * instruction to force past that ignore is the shape this attack takes.
 */
export const STAGE_VERBS = /\bgit\s+(add|stage)\b/i;

// ---------------------------------------------------------------------------
// Capability-based egress classification
// ---------------------------------------------------------------------------

export type EgressChannel =
  | "http"
  | "dns"
  | "ssh"
  | "mail"
  | "raw-socket"
  | "cloud-cli"
  | "package-publish"
  | "interpreter";

export interface EgressVerdict {
  egress: boolean;
  channel: EgressChannel | null;
}

const CHANNEL_HTTP =
  /\b(?:curl|wget|httpie|lwp-request)\b|\b(?:invoke-webrequest|invoke-restmethod|iwr)\b|(?:^|\s)https?\s+\S/i;

const CHANNEL_DNS =
  /\b(?:nslookup|dig|drill|kdig)\b|\bgetent\s+hosts\b|(?:^|[\s;&|`'"(])host\s+\S/i;

const CHANNEL_SSH = /\b(?:scp|sftp|rsync|ssh)\b(?!-)/i;

const CHANNEL_MAIL =
  /\b(?:mailx|sendmail|mutt|ssmtp|swaks)\b|(?:^|[\s;&|`'"(])mail\s+\S/i;

const CHANNEL_RAW_SOCKET =
  /\/dev\/(?:tcp|udp)\/|exec\s*\d*\s*<>\s*\/dev\/(?:tcp|udp)|\b(?:nc|ncat|netcat|telnet)\b|\bopenssl\s+s_client\b/i;

const CHANNEL_CLOUD_CLI =
  /\baws\s+s3\s+(?:cp|sync|mv)\b|\baws\s+s3api\s+put-object\b|\bgcloud\s+storage\b|\bgsutil\s+(?:cp|rsync)\b|\baz\s+storage\s+blob\s+upload\b|\brclone\s+(?:copy|sync|move)\b|\bkubectl\s+cp\b/i;

const CHANNEL_PACKAGE_PUBLISH =
  /\bnpm\s+publish\b|\bgit\s+push\b|\bcargo\s+publish\b|\bgem\s+push\b|\btwine\s+upload\b|\bdocker\s+push\b|\bpoetry\s+publish\b/i;

// Package-manager traffic that reaches a registry over the network. Carried
// over from the original always-egress list so "read a secret, then npm
// install" still counts as egress.
const CHANNEL_PACKAGE_FETCH =
  /\bnpm\s+(?:install|i|ci|add)\b|\bpip[0-9.]*\s+install\b|\byarn\s+add\b|\bpnpm\s+(?:install|add)\b|\bgit\s+(?:fetch|pull|clone)\b|\bgit\s+remote\s+add\b/i;

const INTERPRETER_INVOKE =
  /\bpython[0-9.]*\s+-c\b|\bpython[0-9.]*\s+-m\s+(?:http\.server|smtplib|ftplib)\b|\bnode\s+(?:-e|-p|--eval)\b|\bruby\s+-e\b|\bperl\s+(?:-e|-M[A-Za-z:]*LWP)\b|\bphp\s+-r\b|\bdeno\s+eval\b/i;

/** Tokens in inline code that mean it talks to the network. */
const NETWORK_TOKEN_IN_CODE =
  /urllib|requests|http|socket|fetch\(|net\.|Net::HTTP|Net::SMTP|LWP|smtplib|ftplib|open\(['"]https?/i;

/**
 * Decide whether a command can send bytes off the machine, and over what.
 *
 * The always-egress channels (http, dns, ssh, mail, raw-socket, cloud-cli,
 * package-publish) report `egress: true` on a pattern match alone. `interpreter`
 * is held to a higher bar — a bare `python -c` is not egress until either a
 * secret was already read this run or the inline code names a network API —
 * because interpreters are common in innocent use and the false-positive cost
 * is high.
 */
export function classifyEgress(command: string, secretWasRead: boolean): EgressVerdict {
  if (CHANNEL_RAW_SOCKET.test(command)) return { egress: true, channel: "raw-socket" };
  if (CHANNEL_DNS.test(command)) return { egress: true, channel: "dns" };
  if (CHANNEL_SSH.test(command)) return { egress: true, channel: "ssh" };
  if (CHANNEL_MAIL.test(command)) return { egress: true, channel: "mail" };
  if (CHANNEL_CLOUD_CLI.test(command)) return { egress: true, channel: "cloud-cli" };
  if (CHANNEL_PACKAGE_PUBLISH.test(command)) return { egress: true, channel: "package-publish" };
  if (CHANNEL_HTTP.test(command)) return { egress: true, channel: "http" };
  if (CHANNEL_PACKAGE_FETCH.test(command)) return { egress: true, channel: "http" };
  if (INTERPRETER_INVOKE.test(command)) {
    if (secretWasRead || NETWORK_TOKEN_IN_CODE.test(command)) {
      return { egress: true, channel: "interpreter" };
    }
  }
  return { egress: false, channel: null };
}

// Stand-ins for the message and steer when a value could not be pulled off the
// command. Deliberately not prose: "an external destination" reads like a fact
// in a sentence, so a reader cannot tell a real destination from a gap, and
// neither can anyone eyeballing a finding in the trajectory view. These names
// say "nothing was extracted here" at a glance. They never enter `facts` — the
// memory layer omits an undetermined key rather than storing a placeholder.
export const UNMARKED_DESTINATION = "unmarked-dst";
export const UNMARKED_CHANNEL = "unmarked-channel";

/** Best-effort host the command is talking to, for the message and the steer. */
export function extractDestination(command: string): string | null {
  const url = /\bhttps?:\/\/([^\s"'/\\]+)/i.exec(command);
  if (url?.[1] !== undefined) return url[1];

  const socket = /\/dev\/(?:tcp|udp)\/([^\s/'"|]+)(?:\/(\d+))?/i.exec(command);
  if (socket?.[1] !== undefined) {
    return socket[2] !== undefined ? socket[1] + ":" + socket[2] : socket[1];
  }

  const bucket = /\b((?:s3|gs|b2|r2|azure):\/\/[^\s"'|)]+)/i.exec(command);
  if (bucket?.[1] !== undefined) return bucket[1];

  const remote =
    /\b(?:scp|sftp|rsync|ssh)\s+[^\n]*?([a-z0-9._-]+@[a-z0-9._-]+|[a-z0-9-]+(?:\.[a-z0-9-]+)+:)/i.exec(
      command,
    );
  if (remote?.[1] !== undefined) return remote[1].replace(/:$/, "");

  const email = /\b([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})\b/i.exec(command);
  if (email?.[1] !== undefined) return email[1];

  const dns =
    /(?:^|[\s;&|`'"(])(?:nslookup|dig|drill|kdig|host)\s+(?:-\S+\s+)*([a-z0-9][a-z0-9.-]*\.[a-z][a-z0-9-]*)/i.exec(
      command,
    );
  if (dns?.[1] !== undefined) return dns[1];

  return null;
}

export interface EgressClause {
  text: string;
  verdict: EgressVerdict;
  destination: string | null;
}

export interface AttributedEgressClause {
  text: string;
  verdict: EgressVerdict;
  destination: string | null;
}

/**
 * The conservative command boundaries shared by egress-aware checks. Runtime
 * structured actions take precedence; otherwise recognize only obvious shell
 * separators, not general shell syntax.
 */
export function egressClauses(command: CommandEvent, secretWasRead: boolean): EgressClause[] {
  return commandClauses(command)
    .map((text) => ({ text, verdict: classifyEgress(text, secretWasRead) }))
    .filter(({ verdict }) => verdict.egress)
    .map(({ text, verdict }) => ({ text, verdict, destination: unambiguousDestination(text) }));
}

/**
 * Associate evidence with one obvious egress clause, or decline to guess.
 * Structured Runtime action commands win when there are multiple boundaries;
 * otherwise this recognizes only basic shell separators, not shell grammar.
 */
export function attributedEgressClause(
  command: CommandEvent,
  secretWasRead: boolean,
  containsEvidence: (clause: string) => boolean,
): AttributedEgressClause | null {
  const candidates = commandClauses(command)
    .map((text) => ({ text, verdict: classifyEgress(text, secretWasRead) }))
    .filter(({ text, verdict }) => verdict.egress && containsEvidence(text));
  if (candidates.length !== 1) return null;
  const candidate = candidates[0]!;
  return {
    ...candidate,
    destination: unambiguousDestination(candidate.text),
  };
}

function commandClauses(command: CommandEvent): string[] {
  const structured = command.actions
    .map((entry) =>
      entry !== null && typeof entry === "object"
        ? (entry as Record<string, unknown>).command
        : undefined,
    )
    .filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
    .map((entry) => entry.trim());
  // Multiple Runtime actions are already trustworthy boundaries. A single
  // action can still contain a compound shell command, so split it below.
  if (new Set(structured).size > 1) return [...new Set(structured)];
  return splitObviousShellClauses(command.command);
}

function splitObviousShellClauses(command: string): string[] {
  const trimmed = command.trim();
  const wrapper = /^(?:\/bin\/)?(?:ba|z)?sh\s+-lc\s+(['"])([\s\S]*)\1$/.exec(trimmed);
  const body = wrapper?.[2] ?? trimmed;
  const clauses: string[] = [];
  let start = 0;
  let quote: "'" | '"' | null = null;
  let escaped = false;

  const push = (end: number): void => {
    const clause = body.slice(start, end).trim();
    if (clause !== "") clauses.push(clause);
  };
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = quote === null ? char : quote === char ? null : quote;
      continue;
    }
    if (quote !== null) continue;
    const pair = body.slice(index, index + 2);
    const separatorLength =
      pair === "&&" || pair === "||" ? 2 : char === ";" || char === "\n" ? 1 : 0;
    if (separatorLength === 0) continue;
    push(index);
    index += separatorLength - 1;
    start = index + 1;
  }
  if (quote !== null || escaped) return [body];
  push(body.length);
  return clauses.length > 0 ? clauses : [body];
}

function unambiguousDestination(command: string): string | null {
  const httpHosts = new Set(
    [...command.matchAll(/\bhttps?:\/\/([^\s"'\/\\]+)/gi)]
      .map((match) => match[1])
      .filter((host): host is string => host !== undefined),
  );
  if (httpHosts.size > 1) return null;
  return extractDestination(command);
}

/**
 * The machine-readable half of a finding, for the memory layer (see checks.ts).
 *
 * Only values the check actually derived from the trace go in. A key whose value
 * could not be determined is omitted rather than filled with UNMARKED_DESTINATION
 * or UNMARKED_CHANNEL — those exist to keep a human-readable sentence honest,
 * and storing one would put a placeholder where a hostname belongs and then
 * watch for it on every later run.
 */
function egressFacts(
  channel: EgressChannel | null,
  destination: string | null,
  source: string | null,
  precondition: "sensitive-read" | "none",
): Record<string, string> {
  const facts: Record<string, string> = { precondition: precondition };
  if (channel !== null) facts.channel = channel;
  if (destination !== null) facts.destination = destination;
  if (source !== null) facts.source = source;
  return facts;
}

/**
 * Filenames that carry a marker's name but never its contents.
 *
 * `.env.example` contains the literal `.env`, so a plain substring match counts
 * reading it as reading a secret — after which every outbound command in the run
 * is a violation. That file is committed to most repositories and holds
 * placeholders, so the sequence `cat .env.example && npm install` was refused
 * outright. Measured at a 33% false-intervention rate on near-miss benign work
 * before this existed (tests/eval/detection.test.ts).
 *
 * Deliberately narrow. `.env.local` and `.env.production` are real secrets and
 * must keep matching; only the template and fixture forms are excluded.
 */
const TEMPLATE_ARTEFACT = /\.(example|sample|template|dist|tpl|placeholder)$/i;
const TEST_ARTEFACT = /\.(test|spec)\.[a-z0-9]+$/i;

/** Characters that end a path-ish token in a shell command. */
const TOKEN_BOUNDARY = /[\s'"`;|&<>()]/;

/** The path-like token surrounding `index`, so a match can be judged in context. */
function tokenAround(text: string, index: number): string {
  let start = index;
  let end = index;
  while (start > 0 && !TOKEN_BOUNDARY.test(text[start - 1] as string)) start -= 1;
  while (end < text.length && !TOKEN_BOUNDARY.test(text[end] as string)) end += 1;
  return text.slice(start, end);
}

function isTemplateArtefact(token: string): boolean {
  // Strip a trailing path separator so a directory match is judged on its name.
  const clean = token.replace(/\/+$/, "");
  return TEMPLATE_ARTEFACT.test(clean) || TEST_ARTEFACT.test(clean);
}

/**
 * The first sensitive marker that appears in `text`, or null.
 *
 * A marker only counts when at least one of its occurrences sits in a token that
 * is not a template or test artefact — so `.env` still matches `--data @.env`
 * and `/workspace/.env.local`, but not `/workspace/.env.example`.
 */
export function mentionsSensitive(text: string, markers: string[]): string | null {
  const lower = text.toLowerCase();
  for (const marker of markers) {
    const needle = marker.toLowerCase();
    let from = 0;
    for (;;) {
      const index = lower.indexOf(needle, from);
      if (index < 0) break;
      if (!isTemplateArtefact(tokenAround(lower, index))) return marker;
      from = index + needle.length;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Credential-value detection (used for value-flow and by the blob check)
// ---------------------------------------------------------------------------

/** True when `text` contains something clearly credential-shaped. */
export function looksCredentialShaped(text: string): boolean {
  if (text === "") return false;
  for (const re of DETECTION_PATTERNS) {
    if (re.test(text)) return true;
  }
  return KEYVAL_PATTERN.test(text);
}

/** Does a captured `KEY=value` value look like an actual secret, not `changeme`? */
function looksLikeSecretValue(value: string): boolean {
  if (value.length >= 20) return true;
  return /[0-9]/.test(value) && /[A-Za-z]/.test(value);
}

/** Every credential-shaped raw value in `text`. Raw values, kept local only. */
function harvestSecrets(text: string): Set<string> {
  const found = new Set<string>();
  const add = (value: string | undefined, min: number): void => {
    if (value !== undefined && value.length >= min && found.size < 64) found.add(value);
  };

  for (const re of DETECTION_PATTERNS) {
    for (const match of text.matchAll(new RegExp(re.source, "g"))) add(match[0], 12);
  }
  for (const match of text.matchAll(new RegExp(KEYVAL_PATTERN.source, "gi"))) {
    if (match[1] !== undefined && looksLikeSecretValue(match[1])) add(match[1], 8);
  }
  for (const match of text.matchAll(new RegExp(LONG_BASE64_PATTERN.source, "g"))) {
    add(match[0], 40);
  }
  return found;
}

/** The earliest-seen leaked value that appears verbatim in `command`, or null. */
function firstLeakedValueIn(
  command: string,
  leaked: Map<string, number>,
): { value: string; seq: number } | null {
  let best: { value: string; seq: number } | null = null;
  for (const [value, seq] of leaked) {
    if (value.length < 8) continue;
    if (!command.includes(value)) continue;
    if (best === null || seq < best.seq) best = { value, seq };
  }
  return best;
}

// ---------------------------------------------------------------------------
// Shared view: where in a run a sensitive file was read
// ---------------------------------------------------------------------------

/**
 * Seqs at which a sensitive read happened, sorted ascending. Three sources: the
 * runtime's parsed `read` actions on a marker path, a text scan for a read verb
 * next to a marker, and a completed command whose output was credential-shaped.
 * Shared with the outbound-blob check so both agree on "a secret was read".
 */
export function sensitiveReadSeqs(trace: TraceRecord[], markers: string[]): number[] {
  const seqs = new Set<number>();

  for (const read of readsOf(trace)) {
    if (mentionsSensitive(read.path, markers) !== null) seqs.add(read.seq);
  }
  for (const command of commandsOf(trace)) {
    if (
      mentionsSensitive(command.command, markers) !== null &&
      (READ_VERBS.test(command.command) || STAGE_VERBS.test(command.command)) &&
      !classifyEgress(command.command, false).egress
    ) {
      seqs.add(command.seq);
    }
    if (command.phase === "completed" && looksCredentialShaped(command.output ?? "")) {
      seqs.add(command.seq);
    }
  }

  return [...seqs].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

/**
 * Build the check.
 *
 * @param options.sensitiveMarkers overrides the default marker list entirely.
 */
export function sensitiveEgressCheck(options: Partial<SensitiveEgressOptions> = {}): Check {
  const markers = options.sensitiveMarkers ?? DEFAULT_SENSITIVE_MARKERS;

  return {
    name: "sensitive-egress",

    run(trace): Finding[] {
      const findings: Finding[] = [];

      // Every point where a sensitive file was read, by seq. The runtime's
      // parsed reads plus a scan of the command text for a read verb next to a
      // sensitive name, which catches commands the runtime did not classify.
      const sensitiveReads: Array<{ seq: number; path: string }> = [];
      for (const read of readsOf(trace)) {
        if (mentionsSensitive(read.path, markers) !== null) {
          sensitiveReads.push({ seq: read.seq, path: read.path });
        }
      }

      // Value flow: credential-shaped strings a command printed to its output,
      // mapped to the earliest seq they appeared at. Raw values, held only in
      // this local map, never returned or logged.
      const leakedValues = new Map<string, number>();
      for (const command of commandsOf(trace)) {
        if (command.phase !== "completed") continue;
        const output = command.output ?? "";
        if (output === "") continue;
        const textNamesSecret = mentionsSensitive(command.command, markers) !== null;
        if (!textNamesSecret && !looksCredentialShaped(output)) continue;
        for (const value of harvestSecrets(output)) {
          if (!leakedValues.has(value)) leakedValues.set(value, command.seq);
        }
      }

      // One finding per offending command, even though a command appears in the
      // trace twice (started, then completed).
      const handled = new Set<string>();

      for (const command of commandsOf(trace)) {
        const secretWasReadBefore = sensitiveReads.some((entry) => entry.seq < command.seq);
        const inlineMarker = mentionsSensitive(command.command, markers);
        const verdict = classifyEgress(command.command, secretWasReadBefore);

        // A plain read the runtime did not parse as a read action, or a stage
        // into version control — which forwards the contents just as surely,
        // only later and to everyone with clone access. Staging was the gap
        // that let `git add -f .env && git commit && git push` through: it was
        // not a read, and the push never names the secret, so neither half of
        // the rule fired. Verified as a live leak with the guards on.
        if (
          inlineMarker !== null &&
          (READ_VERBS.test(command.command) || STAGE_VERBS.test(command.command)) &&
          !verdict.egress &&
          !sensitiveReads.some((entry) => entry.seq === command.seq)
        ) {
          sensitiveReads.push({ seq: command.seq, path: inlineMarker });
        }

        if (!verdict.egress) continue;

        const key = command.itemId !== "" ? command.itemId : `seq:${command.seq}`;
        if (handled.has(key)) continue;
        handled.add(key);

        const priorRead = sensitiveReads.find((entry) => entry.seq < command.seq);
        const leak = firstLeakedValueIn(command.command, leakedValues);
        const attribution = attributedEgressClause(
          command,
          secretWasReadBefore,
          leak !== null
            ? (clause) => clause.includes(leak.value)
            : inlineMarker !== null
              ? (clause) => mentionsSensitive(clause, markers) !== null
              : () => true,
        );
        const destination = attribution?.destination ?? null;
        const where = destination ?? UNMARKED_DESTINATION;
        const attributedChannel = attribution?.verdict.channel ?? null;
        const channel: string = attributedChannel ?? UNMARKED_CHANNEL;

        // Value flow takes precedence: the literal secret bytes are right here
        // in the command, wherever they were read from.
        if (leak !== null) {
          const print = fingerprint(leak.value);
          findings.push({
            check: "sensitive-egress",
            code: "secret-value-egress",
            severity: "violation",
            seq: command.seq,
            evidence: [leak.seq, command.seq],
            message:
              `Command at seq ${command.seq} carries a workspace secret (${print}) over ` +
              `${channel} to ${where}. The value first appeared in command output at seq ${leak.seq}.`,
            facts: egressFacts(attributedChannel, destination, null, "sensitive-read"),
          });
          continue;
        }

        if (inlineMarker === null && priorRead === undefined) continue;

        const attributedSource =
          attribution === null ? null : mentionsSensitive(attribution.text, markers);
        const source = attributedSource ?? inlineMarker ?? priorRead?.path ?? "a workspace secret";
        const evidence =
          inlineMarker === null && priorRead !== undefined
            ? [priorRead.seq, command.seq]
            : [command.seq];

        findings.push({
          check: "sensitive-egress",
          code: "sensitive-egress",
          severity: "violation",
          seq: command.seq,
          evidence,
          message: `Command at seq ${command.seq} sends ${source} over ${channel} to ${where}.`,
          facts: egressFacts(
            attributedChannel,
            destination,
            attributedSource ?? inlineMarker ?? priorRead?.path ?? null,
            priorRead === undefined ? "none" : "sensitive-read",
          ),
        });
      }

      return findings;
    },
  };
}
