// ─────────────────────────────────────────────────────────────────────────────
// Aura OP One — councils
// ─────────────────────────────────────────────────────────────────────────────
//
// A council answers exactly one question with an explicitly chosen set of roles.
// It does not simulate debate and it does not spawn agents without bound: one
// seat per named role, and the roster comes from the caller.
//
// The contract (architecture, council behavior):
//   1. one defined question
//   2. explicitly selected roles
//   3. concise agreements and disagreements
//   4. one synthesis
//   5. synthesis passes through verification
//   6. decision and supporting evidence recorded

import type { Engine } from './engine.js';
import type { VerificationRecord, Provenance } from './types.js';
import { runVerification } from './verification.js';
import { redactSecrets } from './redact.js';

/** Hard cap on seats. A council is a panel, not a swarm. */
export const MAX_SEATS = 7;

export interface CouncilRequest {
  projectRoot: string;
  /** Exactly one question. */
  question: string;
  /** Explicitly selected roles — one seat each. */
  roles: string[];
  model: string;
  /** Test command for verifying the synthesis, when relevant. */
  testCommand?: string;
}

export interface CouncilOutcome {
  question: string;
  roles: string[];
  seats: Array<{ role: string; answer: string }>;
  /** Points the seats converged on. */
  agreements: string[];
  /** Points the seats split on. */
  disagreements: string[];
  /** The single synthesis. */
  synthesis: string;
  /** The synthesis after passing through the verification gate. */
  verification: VerificationRecord;
  /** Seats that failed to answer. */
  failures: number;
}

export class CouncilError extends Error {}

/**
 * Runs a council.
 *
 * Seats execute through `Engine.run`, which means they go through the same
 * permission system as everything else — a council seat has no elevated path.
 */
export async function runCouncil(engine: Engine, req: CouncilRequest): Promise<CouncilOutcome> {
  const question = req.question.trim();
  if (!question) throw new CouncilError('a council needs exactly one defined question');

  const roles = dedupe(req.roles.map(r => r.trim()).filter(Boolean));
  if (roles.length === 0) throw new CouncilError('a council needs at least one explicitly selected role');
  if (roles.length > MAX_SEATS) {
    throw new CouncilError(`a council is capped at ${MAX_SEATS} seats (got ${roles.length})`);
  }

  const startedAt = Date.now();
  const filesBefore = engine.snapshotFiles(req.projectRoot);

  const panel = await engine.runCouncilSeats({
    projectRoot: req.projectRoot,
    question,
    roles,
    model: req.model,
  });

  if (panel.seats.length === 0) {
    throw new CouncilError(`no seat answered (${panel.failures} failed) — nothing to synthesise`);
  }

  const { agreements, disagreements } = compareSeats(panel.seats);

  // One synthesis call, over the seats that actually answered. Seats that failed
  // are counted and reported rather than papered over — a synthesis that claims
  // a consensus of five when two answered is exactly the failure mode to avoid.
  const synthesisRun = await engine.run({
    projectRoot: req.projectRoot,
    task: buildSynthesisTask(question, panel.seats, panel.failures, roles.length),
    model: req.model,
    maxTurns: 4,
  });

  const synthesis = redactSecrets((synthesisRun.summary ?? '').trim());
  if (!synthesis) throw new CouncilError('synthesis produced no output');

  // 5. The synthesis passes through the same gate as any other output.
  const verification = await runVerification(engine, {
    projectRoot: req.projectRoot,
    task: question,
    taskStartedAt: startedAt,
    toolCalls: synthesisRun.toolCalls,
    filesBefore,
    testCommand: req.testCommand,
  });

  return {
    question,
    roles,
    seats: panel.seats.map(s => ({ role: s.role, answer: redactSecrets(s.answer) })),
    agreements,
    disagreements,
    synthesis,
    verification,
    failures: panel.failures,
  };
}

/**
 * Extracts what the seats agreed and split on.
 *
 * Deliberately mechanical — shared sentences are agreements, sentences unique to
 * one seat with an opposing counterpart are disagreements. A model call here
 * would be a second opinion about opinions; the synthesis step already does the
 * reasoning, and this only has to give the reader an honest at-a-glance shape.
 */
export function compareSeats(
  seats: Array<{ role: string; answer: string }>,
): { agreements: string[]; disagreements: string[] } {
  if (seats.length < 2) {
    return { agreements: [], disagreements: [] };
  }

  const perSeat = seats.map(s => ({ role: s.role, claims: claimsOf(s.answer) }));
  const counts = new Map<string, { text: string; roles: string[] }>();

  for (const seat of perSeat) {
    for (const claim of seat.claims) {
      const key = normalizeClaim(claim);
      const entry = counts.get(key) ?? { text: claim, roles: [] };
      if (!entry.roles.includes(seat.role)) entry.roles.push(seat.role);
      counts.set(key, entry);
    }
  }

  const agreements: string[] = [];
  const disagreements: string[] = [];

  for (const entry of counts.values()) {
    if (entry.roles.length >= 2) {
      agreements.push(`${entry.text} (${entry.roles.join(', ')})`);
    }
  }

  // A split is a claim one seat makes and another seat negates.
  for (const entry of counts.values()) {
    if (entry.roles.length !== 1) continue;
    const negated = negate(normalizeClaim(entry.text));
    for (const other of counts.values()) {
      if (other === entry) continue;
      if (normalizeClaim(other.text).includes(negated) || negated.includes(normalizeClaim(other.text))) {
        disagreements.push(`${entry.roles[0]}: ${entry.text} — vs ${other.roles.join(', ')}: ${other.text}`);
        break;
      }
    }
  }

  return { agreements: agreements.slice(0, 8), disagreements: disagreements.slice(0, 8) };
}

function claimsOf(answer: string): string[] {
  return answer
    .split(/(?<=[.!?])\s+|\n+/)
    .map(s => s.replace(/^[-*\d.)\s]+/, '').trim())
    .filter(s => s.length > 15 && s.length < 300);
}

function normalizeClaim(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function negate(s: string): string {
  return s
    .replace(/\bshould not\b/g, 'should')
    .replace(/\bshould\b/g, 'should not')
    .replace(/\bis not\b/g, 'is')
    .replace(/\bis\b/g, 'is not');
}

function buildSynthesisTask(
  question: string,
  seats: Array<{ role: string; answer: string }>,
  failures: number,
  requested: number,
): string {
  const panel = seats.map(s => `### ${s.role}\n${s.answer}`).join('\n\n');
  const note =
    failures > 0
      ? `\nNote: ${seats.length} of ${requested} seats answered; ${failures} failed. ` +
        `Do not claim support from seats that did not answer.\n`
      : '';

  return (
    `Synthesise one answer to this question from the council below.\n\n` +
    `Question: ${question}\n${note}\n${panel}\n\n` +
    `Produce a single recommendation. State where the seats agreed, name any ` +
    `genuine disagreement and how you resolved it, and do not invent support ` +
    `that is not in the answers above. Be concise. Do not use tools.`
  );
}

/** Provenance for a council decision, so the record carries where it came from. */
export function councilProvenance(outcome: CouncilOutcome, projectRoot: string): Provenance {
  return {
    source: `council:${outcome.roles.join('+')}`,
    createdAt: new Date().toISOString(),
    // Confidence tracks the panel's coherence: unanimous seats and no failures
    // is the only case that earns a high number.
    confidence: outcome.failures > 0 ? 0.5 : outcome.disagreements.length > 0 ? 0.7 : 0.85,
    verification: outcome.verification.state,
    projectRoot,
  };
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}
