import { describe, it, expect } from 'vitest';
import {
  decideMesh,
  runOnMesh,
  matchesRule,
  createNullTransport,
} from '../src/mesh.js';
import type { MeshTransport, MeshResult } from '../src/mesh.js';
import { DEFAULT_PREFERENCES } from '../src/types.js';
import type { Preferences } from '../src/types.js';
import { createFakeEngine } from './fake-engine.js';

function prefs(over: Partial<Preferences['mesh']> = {}): Preferences {
  return { ...DEFAULT_PREFERENCES, mesh: { ...DEFAULT_PREFERENCES.mesh, ...over } };
}

function transport(result: Partial<MeshResult> & { available?: boolean } = {}): MeshTransport {
  return {
    name: 'fake',
    async available() {
      return result.available ?? true;
    },
    async execute(): Promise<MeshResult> {
      return {
        success: result.success ?? true,
        summary: result.summary ?? 'mesh did the work',
        toolCalls: result.toolCalls ?? [],
        error: result.error,
      };
    },
  };
}

const task = { task: 'do the thing', projectRoot: '/proj', permittedTools: ['read_file', 'edit_file'] };

describe('Agent Mesh is disabled by default', () => {
  it('is off in the default preferences', () => {
    expect(DEFAULT_PREFERENCES.mesh.enabled).toBe(false);
  });

  it('does not run even when a rule would match, while disabled', () => {
    const p = prefs({ enabled: false, rules: [{ match: 'refactor', reason: 'big jobs' }] });
    expect(decideMesh('refactor the parser', p, false).useMesh).toBe(false);
  });

  it('does not run even when explicitly requested, while disabled', () => {
    const decision = decideMesh('anything', prefs({ enabled: false }), true);
    expect(decision.useMesh).toBe(false);
    expect(decision.reason).toMatch(/:mesh on/);
  });

  it('the default transport is never available, so the code path is off too', async () => {
    const engine = createFakeEngine();
    const outcome = await runOnMesh(engine, createNullTransport(), task);
    expect(outcome.ranOnMesh).toBe(false);
    expect(outcome.fallback?.reason).toMatch(/unavailable/);
  });
});

describe('mesh invocation conditions', () => {
  it('runs when explicitly requested and enabled', () => {
    const decision = decideMesh('anything', prefs({ enabled: true }), true);
    expect(decision.useMesh).toBe(true);
    expect(decision.reason).toMatch(/explicitly requested/);
  });

  it('runs on a visible routing rule, and names the rule', () => {
    const p = prefs({ enabled: true, rules: [{ match: 'refactor', reason: 'large refactors fan out' }] });
    const decision = decideMesh('please refactor the parser', p, false);
    expect(decision.useMesh).toBe(true);
    expect(decision.reason).toContain('large refactors fan out');
    expect(decision.rule).toBeDefined();
  });

  it('does not run when enabled but nothing matches', () => {
    const p = prefs({ enabled: true, rules: [{ match: 'refactor', reason: 'r' }] });
    expect(decideMesh('write a haiku', p, false).useMesh).toBe(false);
  });

  it('supports substring and regex rules, and ignores a broken regex', () => {
    expect(matchesRule('Refactor This', { match: 'refactor', reason: '' })).toBe(true);
    expect(matchesRule('migrate db', { match: '/^migrate/', reason: '' })).toBe(true);
    expect(matchesRule('nope', { match: '/[unclosed/', reason: '' })).toBe(false);
  });
});

describe('mesh agents cannot bypass permissions', () => {
  it('permission-checks every action the mesh reports', async () => {
    const engine = createFakeEngine();
    await runOnMesh(engine, transport({
      toolCalls: [
        { name: 'read_file', input: { path: 'a.ts' } },
        { name: 'edit_file', input: { path: 'b.ts' } },
      ],
    }), task);

    expect(engine.permissionChecks.map(c => c.tool)).toEqual(['read_file', 'edit_file']);
  });

  it('drops actions the permission system denies, and reports them', async () => {
    const engine = createFakeEngine({ deniedTools: ['edit_file'] });
    const outcome = await runOnMesh(engine, transport({
      toolCalls: [
        { name: 'read_file', input: { path: 'a.ts' } },
        { name: 'edit_file', input: { path: 'b.ts' } },
      ],
    }), task);

    expect(outcome.result.toolCalls.map(c => c.name)).toEqual(['read_file']);
    expect(outcome.deniedActions).toEqual([
      { tool: 'edit_file', reason: 'edit_file denied by policy' },
    ]);
  });

  it('refuses tools outside the delegated grant', async () => {
    const engine = createFakeEngine();
    const outcome = await runOnMesh(engine, transport({
      toolCalls: [{ name: 'run_shell', input: { command: 'rm -rf /' } }],
    }), task);

    expect(outcome.result.toolCalls).toHaveLength(0);
    expect(outcome.deniedActions[0]).toMatchObject({ tool: 'run_shell' });
    // Never even reached the permission system — the grant stopped it first.
    expect(engine.permissionChecks).toHaveLength(0);
  });
});

describe('mesh failure fallback', () => {
  it('falls back to local execution when the transport is unavailable', async () => {
    const engine = createFakeEngine();
    const outcome = await runOnMesh(engine, transport({ available: false }), task);
    expect(outcome.ranOnMesh).toBe(false);
    expect(outcome.fallback).toMatchObject({ to: 'local-agent' });
    expect(engine.runs).toHaveLength(1);
  });

  it('falls back when the availability check throws', async () => {
    const engine = createFakeEngine();
    const broken: MeshTransport = {
      name: 'broken',
      async available() { throw new Error('network down'); },
      async execute() { throw new Error('unreachable'); },
    };
    const outcome = await runOnMesh(engine, broken, task);
    expect(outcome.ranOnMesh).toBe(false);
    expect(outcome.fallback?.reason).toMatch(/network down/);
  });

  it('falls back when execution throws', async () => {
    const engine = createFakeEngine();
    const broken: MeshTransport = {
      name: 'broken',
      async available() { return true; },
      async execute() { throw new Error('mid-flight failure'); },
    };
    const outcome = await runOnMesh(engine, broken, task);
    expect(outcome.ranOnMesh).toBe(false);
    expect(outcome.fallback?.reason).toMatch(/mid-flight failure/);
    expect(engine.runs).toHaveLength(1);
  });

  it('falls back when the mesh reports failure', async () => {
    const engine = createFakeEngine();
    const outcome = await runOnMesh(engine, transport({ success: false, error: 'no capacity' }), task);
    expect(outcome.ranOnMesh).toBe(false);
    expect(outcome.fallback?.reason).toContain('no capacity');
  });
});
