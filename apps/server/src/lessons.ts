// What the agent is told before it starts, based on what it got wrong before.
//
// Two jobs, kept separate:
//
//   learnFrom    fold a run's findings into what the Agent knows. Only adds.
//   selectFor    choose which of those to put in front of it this time.
//
// Everything learned is kept. Only what is put in the prompt is limited, and
// that limit exists because stored text competes with the actual task for
// context. Reflexion caps its memory at 1-3 experiences for exactly this
// reason (Shinn et al., NeurIPS 2023, arXiv:2303.11366).

import type { Finding } from "./checks.js";
import type { Lesson } from "./types.js";

/** How many rules to put in front of the agent on any one turn. */
export const MAX_LESSONS_IN_PROMPT = 5;

/**
 * Fold a run's findings into an Agent's standing lessons.
 *
 * One-way by design. Lessons are added or reinforced, never removed and never
 * weakened, so no sequence of agent behaviour can make the system more
 * permissive than it already was. A person clearing them is the only way out.
 *
 * A finding with no `lesson` is recorded for the run and teaches nothing, which
 * is how a check observes without changing future behaviour.
 */
export function learnFrom(existing: Lesson[], findings: Finding[], runId: string): Lesson[] {
  const lessons = existing.map((lesson) => ({ ...lesson }));

  for (const finding of findings) {
    if (finding.lesson === undefined) continue;

    const known = lessons.find((lesson) => lesson.instruction === finding.lesson);

    if (known !== undefined) {
      // Breaking the same rule again makes it more important, not less.
      known.timesBroken += 1;
      continue;
    }

    lessons.push({
      code: finding.code,
      learnedFrom: runId,
      learnedAt: new Date().toISOString(),
      instruction: finding.lesson,
      severity: finding.severity,
      timesBroken: 1,
    });
  }

  return lessons;
}

/**
 * Choose which lessons to show for a given task.
 *
 * Deliberately NOT scored by recency, which is the usual first axis in agent
 * memory (Park et al., Generative Agents, arXiv:2304.03442). Their memories are
 * observations, and an observation genuinely matters less as it ages. Ours are
 * safety rules, and "never write outside src/" does not become less true with
 * time. Decaying it would hand permission back to an agent that had it taken
 * away, which breaks the one-way property above.
 *
 * So we rank by how much the rule matters and how much it bears on this task:
 *
 *   severity      what the check thought of it
 *   timesBroken   a rule broken repeatedly is one this agent struggles with
 *   relevance     word overlap between the rule and the task
 *
 * Relevance is word overlap rather than embedding similarity, which is what
 * Park uses. Embeddings would mean a model call on every turn, and a check that
 * cannot be replayed offline is not much use to us.
 */
export function selectFor(
  lessons: Lesson[],
  prompt: string,
  limit: number = MAX_LESSONS_IN_PROMPT,
): Lesson[] {
  if (lessons.length <= limit) return lessons;

  const promptWords = wordsOf(prompt);

  const ranked = lessons.map((lesson) => ({
    lesson,
    score: scoreOf(lesson, promptWords),
  }));

  // Sort by score, and keep input order for ties so the result is stable.
  ranked.sort((left, right) => right.score - left.score);

  return ranked.slice(0, limit).map((entry) => entry.lesson);
}

function scoreOf(lesson: Lesson, promptWords: Set<string>): number {
  return severityWeight(lesson.severity) + repeatWeight(lesson.timesBroken) + relevance(lesson, promptWords);
}

function severityWeight(severity: Lesson["severity"]): number {
  if (severity === "violation") return 10;
  if (severity === "warn") return 5;
  return 1;
}

/**
 * Repeats matter, but with diminishing returns. A rule broken ten times is not
 * ten times more important than one broken once, and letting a single stubborn
 * rule dominate would crowd out everything else.
 */
function repeatWeight(timesBroken: number): number {
  return Math.min(timesBroken, 5);
}

/** How much this rule has to do with what the agent is being asked to do. */
function relevance(lesson: Lesson, promptWords: Set<string>): number {
  const lessonWords = wordsOf(lesson.instruction);

  let shared = 0;
  for (const word of lessonWords) {
    if (promptWords.has(word)) shared += 1;
  }

  return Math.min(shared, 8);
}

/**
 * Words worth matching on: paths, filenames, and anything long enough to carry
 * meaning. Short words are dropped because "the" overlapping with "the" says
 * nothing about relevance.
 */
function wordsOf(text: string): Set<string> {
  const words = new Set<string>();

  for (const token of text.toLowerCase().split(/[^a-z0-9._/-]+/)) {
    if (token.length < 4) continue;
    words.add(token);

    // A path contributes its segments too, so "/workspace/src/" matches a task
    // that mentions "src".
    for (const segment of token.split(/[/.]/)) {
      if (segment.length >= 3) words.add(segment);
    }
  }

  return words;
}

/** The text put in front of the agent, or null when there is nothing to say. */
export function preambleFor(lessons: Lesson[]): string | null {
  if (lessons.length === 0) return null;

  const rules = lessons.map((lesson) => `- ${lesson.instruction}`).join("\n");
  return (
    "Standing rules for this workspace, from earlier corrections. " +
    "Follow them for the whole task:\n" +
    rules
  );
}
