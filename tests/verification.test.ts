import { describe, it, expect } from 'vitest';
import {
  transition,
  canTransition,
  runVerification,
  stateLabel,
  unverifiedRecord,
  mayCommit,
  LEGAL_TRANSITIONS,
  IllegalTransitionError,
} from '../src/verification.js';
import { VERIFICATION_STATES } from '../src/types.js';
import type { VerificationState } from '../src/types.js';
import { createFakeEngine } from './fake-engine.js';

const req = {
  projectRoot: '/proj',
  task: 'fix it',
  taskStartedAt: Date.now(),
  toolCalls: [{ name: 'edit_file', input: { path: 'a.ts' } }],
  filesBefore: new Set<string>(),
};

describe('verification state transitions', () => {
  it('defines a rule for every state', () => {
    for (const s of VERIFICATION_STATES) {
      expect(LEGAL_TRANSITIONS[s]).toBeDefined();
    }
  });

  it('allows only the documented moves', () => {
    expect(canTransition('unverified', 'verification_pending')).toBe(true);
    expect(canTransition('verification_pending', 'verified')).toBe(true);
    expect(canTransition('verification_pending', 'rejected')).toBe(true);
    expect(canTransition('verification_pending', 'escalated')).toBe(true);
    expect(canTransition('rejected', 'verification_pending')).toBe(true);
    expect(canTransition('escalated', 'verification_pending')).toBe(true);
    expect(canTransition('escalated', 'rejected')).toBe(true);
  });

  it('never lets anything reach "verified" except from "verification_pending"', () => {
    const sources = VERIFICATION_STATES.filter(s => s !== 'verification_pending');
    for (const from of sources) {
      expect(canTransition(from as VerificationState, 'verified'), from).toBe(false);
    }
  });

  it('treats "verified" as terminal', () => {
    expect(LEGAL_TRANSITIONS.verified).toEqual([]);
    for (const to of VERIFICATION_STATES) {
      expect(canTransition('verified', to as VerificationState)).toBe(false);
    }
  });

  it('throws on an illegal transition rather than silently coercing', () => {
    expect(() => transition('unverified', 'verified')).toThrow(IllegalTransitionError);
    expect(() => transition('rejected', 'verified')).toThrow(/illegal verification transition/);
  });

  it('labels every state', () => {
    for (const s of VERIFICATION_STATES) {
      expect(stateLabel(s as VerificationState)).toBeTruthy();
    }
    expect(stateLabel('verified')).toBe('verified');
    expect(stateLabel('unverified')).toBe('unverified');
  });
});

describe('running verification', () => {
  it('reaches "verified" when the gate approves', async () => {
    const engine = createFakeEngine({ verifyPasses: true });
    const record = await runVerification(engine, req);
    expect(record.state).toBe('verified');
    expect(record.checks.every(c => c.passed)).toBe(true);
  });

  it('reaches "rejected" when the gate declines', async () => {
    const engine = createFakeEngine({ verifyPasses: false });
    const record = await runVerification(engine, req);
    expect(record.state).toBe('rejected');
    expect(record.decision).toContain('fake check failed');
  });

  it('escalates rather than passing when the gate itself fails', async () => {
    const engine = createFakeEngine({ verifyThrows: true });
    const record = await runVerification(engine, req);
    expect(record.state).toBe('escalated');
    expect(record.state).not.toBe('verified');
    expect(record.decision).toContain('gate exploded');
  });

  it('records the evidence the gate examined', async () => {
    const engine = createFakeEngine({ verifyPasses: true });
    const record = await runVerification(engine, {
      ...req,
      toolCalls: [
        { name: 'edit_file', input: { path: 'src/a.ts' } },
        { name: 'write_file', input: { path: 'src/b.ts' } },
        { name: 'run_shell', input: { command: 'npm test' } },
      ],
    });
    expect(record.evidence.filesChanged).toEqual(['src/a.ts', 'src/b.ts']);
    expect(record.evidence.testsExecuted).toEqual(['npm test']);
    expect(record.evidence.toolCalls).toHaveLength(3);
  });

  it('a fresh record starts unverified', () => {
    expect(unverifiedRecord().state).toBe('unverified');
  });
});

describe('the commit gate', () => {
  const verified = { ...unverifiedRecord(), state: 'verified' as VerificationState };

  it('requires user approval even for verified work — verification is not permission', () => {
    expect(mayCommit(verified, false)).toMatchObject({ allowed: false });
    expect(mayCommit(verified, false).reason).toMatch(/has not approved/);
  });

  it('requires verification even with user approval', () => {
    for (const state of ['unverified', 'rejected', 'escalated', 'verification_pending'] as const) {
      const record = { ...unverifiedRecord(), state };
      expect(mayCommit(record, true).allowed, state).toBe(false);
    }
  });

  it('allows the commit only when both gates pass', () => {
    expect(mayCommit(verified, true)).toEqual({ allowed: true, reason: 'verified and approved' });
  });
});
