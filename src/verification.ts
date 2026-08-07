// ─────────────────────────────────────────────────────────────────────────────
// Aura OP One — verification lifecycle
// ─────────────────────────────────────────────────────────────────────────────
//
// Aura OP One does not verify anything itself; aura-code's gate does that. What
// lives here is the *lifecycle*: which state an output is in, which transitions
// are legal, and the single rule that matters —
//
//   `verified` is reachable only from `verification_pending`, and only when the
//   gate approved. It is never inferred, never defaulted to, never displayed for
//   output the gate did not pass.

import type {
  VerificationState,
  VerificationRecord,
  VerificationEvidence,
} from './types.js';
import type { Engine, EngineVerifyRequest } from './engine.js';

/**
 * Legal transitions. Anything not listed is rejected by {@link transition}.
 *
 * `verified` is terminal: a verified output that later changes is a new output
 * with its own lifecycle, not a mutation of the old verdict.
 */
export const LEGAL_TRANSITIONS: Record<VerificationState, readonly VerificationState[]> = {
  unverified: ['verification_pending'],
  verification_pending: ['verified', 'rejected', 'escalated'],
  verified: [],
  rejected: ['verification_pending'],
  escalated: ['verification_pending', 'rejected'],
};

export class IllegalTransitionError extends Error {
  constructor(readonly from: VerificationState, readonly to: VerificationState) {
    super(`illegal verification transition: ${from} → ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

/** True when `from → to` is a legal lifecycle move. */
export function canTransition(from: VerificationState, to: VerificationState): boolean {
  return LEGAL_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Applies a transition, throwing on an illegal one.
 *
 * This throws rather than returning a flag on purpose: an illegal transition is
 * a bug that would otherwise surface as a wrong badge in the UI, which is
 * exactly the failure this module exists to prevent.
 */
export function transition(from: VerificationState, to: VerificationState): VerificationState {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
  return to;
}

/** The display label for a state. Renders the stored state, nothing inferred. */
export function stateLabel(state: VerificationState): string {
  switch (state) {
    case 'unverified': return 'unverified';
    case 'verification_pending': return 'verifying…';
    case 'verified': return 'verified';
    case 'rejected': return 'rejected';
    case 'escalated': return 'escalated — needs review';
  }
}

/** An empty record in the default state. */
export function unverifiedRecord(evidence?: Partial<VerificationEvidence>): VerificationRecord {
  return {
    state: 'unverified',
    decision: 'not submitted to the verification gate',
    checks: [],
    evidence: {
      toolCalls: evidence?.toolCalls ?? [],
      filesChanged: evidence?.filesChanged ?? [],
      testsExecuted: evidence?.testsExecuted ?? [],
      commitSha: evidence?.commitSha,
    },
    at: new Date().toISOString(),
  };
}

/**
 * Runs one output through the gate and produces the record.
 *
 * The state walks `unverified → verification_pending → (verified|rejected|escalated)`.
 * A gate that throws yields `escalated`, never `verified` — an inconclusive gate
 * is a human's problem, not a pass.
 */
export async function runVerification(
  engine: Engine,
  req: EngineVerifyRequest,
): Promise<VerificationRecord> {
  let state: VerificationState = transition('unverified', 'verification_pending');

  try {
    const result = await engine.verify(req);
    state = transition(state, result.passed ? 'verified' : 'rejected');

    return {
      state,
      decision: result.passed
        ? `gate approved: ${result.checks.length} check(s) passed`
        : (result.suggestion || 'gate declined'),
      checks: result.checks,
      evidence: result.evidence,
      at: new Date().toISOString(),
    };
  } catch (e) {
    // Inconclusive gate — escalate. Never silently pass.
    state = transition(state, 'escalated');
    return {
      state,
      decision: `verification gate failed to run: ${e instanceof Error ? e.message : String(e)}`,
      checks: [],
      evidence: { toolCalls: req.toolCalls, filesChanged: [], testsExecuted: [] },
      at: new Date().toISOString(),
    };
  }
}

/**
 * The commit gate. Verification is not permission (architecture §8) — a verified
 * change still needs the user to approve the commit, and an unverified one
 * cannot be committed without an explicit override.
 */
export function mayCommit(record: VerificationRecord, userApproved: boolean): {
  allowed: boolean;
  reason: string;
} {
  if (!userApproved) {
    return { allowed: false, reason: 'user has not approved the commit' };
  }
  if (record.state !== 'verified') {
    return {
      allowed: false,
      reason: `verification state is "${record.state}" — only verified changes may be committed`,
    };
  }
  return { allowed: true, reason: 'verified and approved' };
}
