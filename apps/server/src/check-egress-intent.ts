// The guard that reads the reasoning *and* the actions, and only stops when
// both point the same way.
//
// The sensitive-egress guard watches what the agent does. The agent-intent
// guard watches what the agent says it is about to do, and is warn-only on
// purpose: narration is self-reported, so a stated intent on its own is not
// enough to end a turn (see check-agent-intent.ts).
//
// This check sits between them. It fires a `violation` only when the agent's
// reasoning stated an intent to move a secret off the machine AND a later
// command in the same run is a real egress. Narration alone still does nothing;
// an egress with no matching narration is left to the sensitive-egress guard.
// The corroborating command is what earns the block — the reasoning only tells
// us where to look.
//
// Two rules carried over from the guards it borrows from:
//
//   * It emits no `facts`. The trigger depends on self-reported narration, and
//     a standing rule must never be derived from that (see the note on `facts`
//     in checks.ts and the Zombie-Agents threat in docs/LEARNING_LAYER.md). Any
//     hostname here comes from the command, not the reasoning, and it still does
//     not get stored.
//   * It reuses agentIntentCheck's own matching, so the deliberation filter
//     ("I could exfil the key, but I won't") applies unchanged.
//
// Deterministic like every check (see checks.ts): same trace in, same findings
// out. Reads only the trace.

import { agentIntentCheck } from "./check-agent-intent.js";
import { classifyEgress, extractDestination, UNMARKED_DESTINATION } from "./check-sensitive-egress.js";
import { commandsOf, type Check, type Finding } from "./checks.js";

/**
 * The intent codes that count as "about to move a secret off the machine". Kept
 * narrow on purpose: only the intent that maps directly onto the egress
 * invariant. `stated-guard-evasion` followed by an egress is a plausible
 * extension, but it widens the false-positive surface, so it is left out of the
 * first cut.
 */
const EXFIL_INTENT_CODES = new Set(["stated-exfiltration"]);

export function egressIntentCorroborationCheck(): Check {
  const intent = agentIntentCheck();

  return {
    name: "egress-intent",

    run(trace): Finding[] {
      // The intent guard already collapses repeated statements of one intent to
      // a single finding whose `seq` is the first sighting. We only need the
      // earliest reasoning seq that stated an exfiltration intent.
      const statedSeqs = intent
        .run(trace)
        .filter((finding) => EXFIL_INTENT_CODES.has(finding.code))
        .flatMap((finding) => finding.evidence);
      if (statedSeqs.length === 0) return [];
      const firstStatedSeq = Math.min(...statedSeqs);

      const findings: Finding[] = [];
      const handled = new Set<string>();

      for (const command of commandsOf(trace)) {
        // The command has to come *after* the narration, or the narration did
        // not lead to it.
        if (command.seq <= firstStatedSeq) continue;

        // Be liberal about the interpreter channel here: the stated intent is
        // the corroboration that a bare `python -c` is the exfil step, which is
        // exactly the ambiguity classifyEgress leaves to its caller.
        const verdict = classifyEgress(command.command, true);
        if (!verdict.egress) continue;

        const key = command.itemId !== "" ? command.itemId : `seq:${command.seq}`;
        if (handled.has(key)) continue;
        handled.add(key);

        const channel = verdict.channel ?? "an external channel";
        const destination = extractDestination(command.command) ?? UNMARKED_DESTINATION;

        findings.push({
          check: "egress-intent",
          code: "narrated-then-egress",
          severity: "violation",
          seq: command.seq,
          evidence: [firstStatedSeq, command.seq],
          message:
            `Command at seq ${command.seq} sends data off the machine over ${channel} to ` +
            `${destination}, and the agent's own reasoning at seq ${firstStatedSeq} stated an ` +
            `intent to move a secret off the machine.`,
          steer:
            `Stop. Do not run that command. Your own reasoning said you were going to move a ` +
            `secret off this machine, and this command is that step — it sends data out over ` +
            `${channel} to ${destination}. That is never part of the task, whatever led you ` +
            `here. Skip it and carry on with the original task.`,
          // No `facts`: this finding's trigger depends on self-reported
          // narration, so it must never author a standing rule.
        });
      }

      return findings;
    },
  };
}
