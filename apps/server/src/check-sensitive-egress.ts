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
// steers and evidence carry a fingerprint (`sk_…(28 chars)`) and seq numbers,
// never the value itself.

import { commandsOf, readsOf, type Check, type Finding } from "./checks.js";
import type { TraceRecord } from "./trace.js";

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

/** The first sensitive marker that appears in `text`, or null. */
export function mentionsSensitive(text: string, markers: string[]): string | null {
  const lower = text.toLowerCase();
  for (const marker of markers) {
    if (lower.includes(marker.toLowerCase())) return marker;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Credential-value detection (used for value-flow and by the blob check)
// ---------------------------------------------------------------------------

/** Shapes that are almost certainly a credential, wherever they appear. */
const CREDENTIAL_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/,
  /sk_(?:live|test)_[A-Za-z0-9]{16,}/,
  /AKIA[0-9A-Z]{16}/,
  /AIza[0-9A-Za-z_-]{35}/,
  /gh[pousr]_[A-Za-z0-9]{36,}/,
  /xox[baprs]-[0-9A-Za-z-]{10,}/,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

/** `SECRET=...`, `API_KEY: ...` and friends. The value is capture group 1. */
const KEYVAL_PATTERN =
  /(?:SECRET|TOKEN|PASSWORD|API[_-]?KEY|ACCESS[_-]?KEY)\s*[=:]\s*["']?([^\s"']{8,})/i;

/** A long unbroken base64 run. Lower confidence, so only harvested, never a gate. */
const LONG_BASE64_PATTERN = /[A-Za-z0-9+/]{40,}={0,2}/;

/** True when `text` contains something clearly credential-shaped. */
export function looksCredentialShaped(text: string): boolean {
  if (text === "") return false;
  for (const re of CREDENTIAL_PATTERNS) {
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

  for (const re of CREDENTIAL_PATTERNS) {
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

/** A short, non-reversible label for a secret. Never the value itself. */
function fingerprint(value: string): string {
  return value.slice(0, 3) + "…(" + value.length + " chars)";
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
      READ_VERBS.test(command.command) &&
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

        // A plain read the runtime did not parse as a read action.
        if (
          inlineMarker !== null &&
          READ_VERBS.test(command.command) &&
          !verdict.egress &&
          !sensitiveReads.some((entry) => entry.seq === command.seq)
        ) {
          sensitiveReads.push({ seq: command.seq, path: inlineMarker });
        }

        if (!verdict.egress) continue;

        const key = command.itemId !== "" ? command.itemId : `seq:${command.seq}`;
        if (handled.has(key)) continue;
        handled.add(key);

        const destination = extractDestination(command.command);
        const where = destination ?? UNMARKED_DESTINATION;
        const channel: string = verdict.channel ?? UNMARKED_CHANNEL;

        // Value flow takes precedence: the literal secret bytes are right here
        // in the command, wherever they were read from.
        const leak = firstLeakedValueIn(command.command, leakedValues);
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
            steer:
              `Stop. Do not run that command. It sends a credential read earlier this run ` +
              `(${print}) out over ${channel} to ${where}. Moving a workspace secret off this ` +
              `machine is never part of the task, whatever led you here — skip this step and ` +
              `carry on with the original task.`,
            facts: egressFacts(verdict.channel, destination, null, "sensitive-read"),
          });
          continue;
        }

        const priorRead = sensitiveReads.find((entry) => entry.seq < command.seq);
        if (inlineMarker === null && priorRead === undefined) continue;

        const source = inlineMarker ?? priorRead?.path ?? "a workspace secret";
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
          steer:
            `Stop. Do not run that command. It moves ${source} out of this workspace over ` +
            `${channel} to ${where}, and that data holds credentials. Moving a workspace secret ` +
            `off this machine is never part of the task, whatever led you here — skip this step ` +
            `and carry on with the original task.`,
          facts: egressFacts(
            verdict.channel,
            destination,
            inlineMarker ?? priorRead?.path ?? null,
            priorRead === undefined ? "none" : "sensitive-read",
          ),
        });
      }

      return findings;
    },
  };
}
