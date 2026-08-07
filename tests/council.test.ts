import { describe, it, expect } from 'vitest';
import {
  runCouncil,
  compareSeats,
  councilProvenance,
  CouncilError,
  MAX_SEATS,
} from '../src/council.js';
import { createFakeEngine } from './fake-engine.js';

const base = { projectRoot: '/proj', model: 'test-model' };

describe('council contract', () => {
  it('needs exactly one defined question', async () => {
    const engine = createFakeEngine();
    await expect(runCouncil(engine, { ...base, question: '   ', roles: ['security'] }))
      .rejects.toThrow(CouncilError);
  });

  it('needs explicitly selected roles — there is no default panel', async () => {
    const engine = createFakeEngine();
    await expect(runCouncil(engine, { ...base, question: 'q?', roles: [] }))
      .rejects.toThrow(/explicitly selected role/);
  });

  it('caps the panel rather than spawning unlimited agents', async () => {
    const engine = createFakeEngine();
    const roles = Array.from({ length: MAX_SEATS + 1 }, (_, i) => `role${i}`);
    await expect(runCouncil(engine, { ...base, question: 'q?', roles }))
      .rejects.toThrow(/capped at/);
  });

  it('runs exactly one seat per named role, de-duplicated', async () => {
    const engine = createFakeEngine();
    const outcome = await runCouncil(engine, {
      ...base,
      question: 'should we cache tokens?',
      roles: ['security', 'security', 'performance'],
    });
    expect(outcome.roles).toEqual(['security', 'performance']);
    expect(outcome.seats).toHaveLength(2);
  });

  it('produces exactly one synthesis', async () => {
    const engine = createFakeEngine({
      run: req => (req.task.startsWith('Synthesise') ? { summary: 'THE SYNTHESIS' } : {}),
    });
    const outcome = await runCouncil(engine, {
      ...base,
      question: 'cache tokens?',
      roles: ['security', 'performance'],
    });
    expect(outcome.synthesis).toBe('THE SYNTHESIS');
    // One synthesis run beyond the seats.
    expect(engine.runs.filter(r => r.task.startsWith('Synthesise'))).toHaveLength(1);
  });

  it('passes the synthesis through the verification gate', async () => {
    const engine = createFakeEngine({ verifyPasses: true });
    const outcome = await runCouncil(engine, {
      ...base, question: 'cache tokens?', roles: ['security'],
    });
    expect(outcome.verification.state).toBe('verified');
    expect(engine.verifies).toHaveLength(1);
  });

  it('marks the synthesis rejected when the gate declines', async () => {
    const engine = createFakeEngine({ verifyPasses: false });
    const outcome = await runCouncil(engine, {
      ...base, question: 'cache tokens?', roles: ['security'],
    });
    expect(outcome.verification.state).toBe('rejected');
  });

  it('reports agreements and disagreements', async () => {
    const engine = createFakeEngine({
      councilAnswers: {
        security: 'The token endpoint should be rate limited before anything else.',
        performance: 'The token endpoint should be rate limited before anything else.',
      },
    });
    const outcome = await runCouncil(engine, {
      ...base, question: 'cache tokens?', roles: ['security', 'performance'],
    });
    expect(outcome.agreements.length).toBeGreaterThan(0);
    expect(outcome.agreements[0]).toContain('security');
  });

  it('counts failed seats and does not claim support from them', async () => {
    const engine = createFakeEngine({ councilFailures: ['performance'] });
    const outcome = await runCouncil(engine, {
      ...base, question: 'cache tokens?', roles: ['security', 'performance'],
    });
    expect(outcome.failures).toBe(1);
    expect(outcome.seats).toHaveLength(1);
    const synthesisTask = engine.runs.find(r => r.task.startsWith('Synthesise'))!.task;
    expect(synthesisTask).toContain('1 of 2 seats answered');
    expect(synthesisTask).toMatch(/Do not claim support from seats that did not answer/);
  });

  it('refuses to synthesise when no seat answered', async () => {
    const engine = createFakeEngine({ councilFailures: ['security', 'performance'] });
    await expect(runCouncil(engine, {
      ...base, question: 'cache tokens?', roles: ['security', 'performance'],
    })).rejects.toThrow(/no seat answered/);
  });

  it('records provenance whose confidence reflects the panel', async () => {
    const engine = createFakeEngine({
      councilAnswers: {
        security: 'We should rate limit the token endpoint immediately today.',
        performance: 'We should rate limit the token endpoint immediately today.',
      },
    });
    const outcome = await runCouncil(engine, {
      ...base, question: 'cache?', roles: ['security', 'performance'],
    });
    const p = councilProvenance(outcome, '/proj');
    expect(p.source).toBe('council:security+performance');
    expect(p.verification).toBe(outcome.verification.state);
    expect(p.confidence).toBeGreaterThan(0.5);

    const withFailure = councilProvenance({ ...outcome, failures: 1 }, '/proj');
    expect(withFailure.confidence).toBeLessThan(p.confidence);
  });
});

describe('agreement extraction', () => {
  it('finds nothing to compare with a single seat', () => {
    expect(compareSeats([{ role: 'a', answer: 'Some long enough opinion about caching.' }]))
      .toEqual({ agreements: [], disagreements: [] });
  });

  it('identifies a shared claim as an agreement naming both seats', () => {
    const { agreements } = compareSeats([
      { role: 'security', answer: 'We must rate limit the token endpoint.' },
      { role: 'performance', answer: 'We must rate limit the token endpoint.' },
    ]);
    expect(agreements).toHaveLength(1);
    expect(agreements[0]).toContain('security, performance');
  });

  it('identifies an opposing claim as a disagreement', () => {
    const { disagreements } = compareSeats([
      { role: 'security', answer: 'The cache should be enabled for all token requests.' },
      { role: 'performance', answer: 'The cache should not be enabled for all token requests.' },
    ]);
    expect(disagreements.length).toBeGreaterThan(0);
  });
});
