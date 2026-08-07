import { describe, it, expect } from 'vitest';
import {
  validateAgent,
  isValidAgent,
  defaultAgent,
  AgentSchemaError,
} from '../src/agent-schema.js';
import type { AgentDefinition } from '../src/types.js';

function valid(overrides: Partial<AgentDefinition> = {}): Record<string, unknown> {
  return {
    id: 'reviewer',
    name: 'Reviewer',
    purpose: 'Reviews code changes.',
    instruction: 'Review the diff and report problems.',
    permittedTools: ['read_file', 'search_code'],
    modelPolicy: { kind: 'local-first' },
    verificationPolicy: 'always',
    memoryScope: 'engineering',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('agent schema validation', () => {
  it('accepts a well-formed definition and returns it normalised', () => {
    const agent = validateAgent(valid());
    expect(agent.id).toBe('reviewer');
    expect(agent.permittedTools).toEqual(['read_file', 'search_code']);
    expect(agent.modelPolicy).toEqual({ kind: 'local-first' });
  });

  it('requires every field the architecture defines for an agent', () => {
    for (const field of ['id', 'name', 'purpose', 'instruction', 'createdAt']) {
      const input = valid();
      delete input[field];
      expect(() => validateAgent(input), field).toThrow(AgentSchemaError);
    }
  });

  it('reports every problem at once rather than stopping at the first', () => {
    let issues: string[] = [];
    try {
      validateAgent({ id: '', name: '', purpose: 'p', instruction: 'i', permittedTools: [], modelPolicy: { kind: 'nope' }, verificationPolicy: 'bad', memoryScope: 'bad', createdAt: 'not-a-date' });
    } catch (e) {
      issues = (e as AgentSchemaError).issues;
    }
    // id, name, modelPolicy.kind, verificationPolicy, memoryScope, createdAt
    expect(issues.length).toBeGreaterThanOrEqual(6);
  });

  it('rejects unknown tools so a typo narrows an agent instead of silently widening it', () => {
    expect(() => validateAgent(valid({ permittedTools: ['read_file', 'launch_missiles'] } as never)))
      .toThrow(/unknown tool "launch_missiles"/);
  });

  it('rejects an invalid id shape', () => {
    expect(() => validateAgent(valid({ id: 'has spaces' }))).toThrow(/id:/);
    expect(() => validateAgent(valid({ id: '-leading-dash' }))).toThrow(/id:/);
  });

  it('rejects unknown model policies and requires a model for pinned', () => {
    expect(() => validateAgent(valid({ modelPolicy: { kind: 'psychic' } as never })))
      .toThrow(/modelPolicy.kind/);
    expect(() => validateAgent(valid({ modelPolicy: { kind: 'pinned' } as never })))
      .toThrow(/requires a non-empty "model"/);
    expect(validateAgent(valid({ modelPolicy: { kind: 'pinned', model: 'gpt-4o' } })).modelPolicy)
      .toEqual({ kind: 'pinned', model: 'gpt-4o' });
  });

  it('constrains verification policy and memory scope to the defined values', () => {
    expect(() => validateAgent(valid({ verificationPolicy: 'sometimes' as never })))
      .toThrow(/verificationPolicy/);
    expect(() => validateAgent(valid({ memoryScope: 'everything' as never })))
      .toThrow(/memoryScope/);
  });

  it('isValidAgent mirrors validateAgent without throwing', () => {
    expect(isValidAgent(valid())).toBe(true);
    expect(isValidAgent({ id: 'x' })).toBe(false);
    expect(isValidAgent(null)).toBe(false);
    expect(isValidAgent([])).toBe(false);
  });

  it('the built-in default agent is itself schema-valid', () => {
    expect(() => validateAgent(defaultAgent())).not.toThrow();
  });
});
