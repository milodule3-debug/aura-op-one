// Tests against the REAL engine, not the fake.
//
// Everything else in tests/op-one/ substitutes a fake engine, which proves the
// boundary is clean but says nothing about whether it is wired to aura-code
// correctly. These tests exercise the parts of `createAuraCodeEngine` that need
// no provider, no network and no API key — permission enforcement, the file
// snapshot, and evidence extraction — so a break in the actual wiring is caught.

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createAuraCodeEngine, extractEvidence } from '../src/engine.js';

describe('real engine — permission enforcement', () => {
  it('enforces read-only through aura-code\'s permission system', () => {
    const engine = createAuraCodeEngine({ permissionLevel: 'read-only' });

    expect(engine.checkPermission('read_file', { path: 'a.ts' }).allowed).toBe(true);
    expect(engine.checkPermission('list_dir', { path: '.' }).allowed).toBe(true);

    const write = engine.checkPermission('write_file', { path: 'a.ts' });
    expect(write.allowed).toBe(false);
    expect(write.reason).toMatch(/read-only/i);
  });

  it('blocks dangerous shell commands even at the most permissive level', () => {
    const engine = createAuraCodeEngine({ permissionLevel: 'auto' });

    const danger = engine.checkPermission('run_shell', { command: 'rm -rf /' });
    expect(danger.allowed).toBe(false);
    expect(danger.reason).toMatch(/dangerous/i);
  });

  it('translates aura-code\'s needsConfirm into the client\'s needsConfirmation', () => {
    // aura-code returns `{ allowed: true, needsConfirm: true }` for a shell
    // command that is neither on the safe list nor dangerous. Reading the wrong
    // field name here silently drops every confirmation prompt, so the mapping
    // is asserted against the real permission system rather than assumed.
    const engine = createAuraCodeEngine({ permissionLevel: 'normal' });
    const outcome = engine.checkPermission('run_shell', { command: 'curl https://example.com' });

    expect(outcome.allowed).toBe(true);
    expect(outcome.needsConfirmation).toBe(true);
  });

  it('is available immediately — no window where an early check fails closed', () => {
    // Constructed and checked in the same tick: the permission system is loaded
    // synchronously precisely so this cannot return a spurious denial.
    const engine = createAuraCodeEngine({ permissionLevel: 'read-only' });
    expect(engine.checkPermission('read_file', { path: 'a.ts' })).toEqual({
      allowed: true,
      needsConfirmation: undefined,
      reason: undefined,
    });
  });
});

describe('real engine — file snapshot', () => {
  it('captures the project file set the verification gate needs', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opone-snap-'));
    try {
      fs.writeFileSync(path.join(tmp, 'a.ts'), 'export const a = 1;');
      fs.mkdirSync(path.join(tmp, 'src'));
      fs.writeFileSync(path.join(tmp, 'src', 'b.ts'), 'export const b = 2;');

      const engine = createAuraCodeEngine();
      const files = engine.snapshotFiles(tmp);

      expect(files.size).toBeGreaterThanOrEqual(2);
      expect([...files].some(f => f.endsWith('a.ts'))).toBe(true);
      expect([...files].some(f => f.endsWith('b.ts'))).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns an empty set for a missing root rather than throwing', () => {
    const engine = createAuraCodeEngine();
    expect(engine.snapshotFiles('/definitely/not/a/real/path').size).toBe(0);
  });
});

describe('real engine — evidence extraction', () => {
  it('derives files changed and tests executed from the tool-call log', () => {
    const evidence = extractEvidence([
      { name: 'read_file', input: { path: 'src/a.ts' } },
      { name: 'edit_file', input: { path: 'src/a.ts' } },
      { name: 'write_file', input: { path: 'src/b.ts' } },
      { name: 'run_shell', input: { command: 'npm test' } },
      { name: 'run_shell', input: { command: 'ls -la' } },
    ]);

    // Reads are not changes; the edited file appears once despite two mentions.
    expect(evidence.filesChanged).toEqual(['src/a.ts', 'src/b.ts']);
    expect(evidence.testsExecuted).toEqual(['npm test']);
    expect(evidence.toolCalls).toHaveLength(5);
  });

  it('recognises the common test runners', () => {
    for (const cmd of ['vitest run', 'npx jest', 'pytest -q', 'go test ./...', 'cargo test', 'node --test']) {
      const evidence = extractEvidence([{ name: 'run_shell', input: { command: cmd } }]);
      expect(evidence.testsExecuted, cmd).toEqual([cmd]);
    }
  });

  it('recognises a project-specific test command it would not otherwise match', () => {
    const evidence = extractEvidence(
      [{ name: 'run_shell', input: { command: 'make check-everything' } }],
      'make check-everything',
    );
    expect(evidence.testsExecuted).toEqual(['make check-everything']);
  });

  it('counts run_tests as a test execution', () => {
    const evidence = extractEvidence([{ name: 'run_tests', input: {} }]);
    expect(evidence.testsExecuted).toEqual(['run_tests']);
  });
});

describe('real engine — model resolution without a provider', () => {
  it('honours a pinned policy without touching the network', async () => {
    const engine = createAuraCodeEngine();
    const resolved = await engine.resolveModel({
      policy: { kind: 'pinned', model: 'gpt-4o' },
      task: 'anything',
      projectRoot: '/proj',
    });
    expect(resolved).toMatchObject({ model: 'gpt-4o', isLocal: false });
  });

  it('lets a session override win over the agent policy', async () => {
    const engine = createAuraCodeEngine();
    const resolved = await engine.resolveModel({
      policy: { kind: 'local-first' },
      task: 'anything',
      projectRoot: '/proj',
      override: 'claude-sonnet-4-5',
    });
    expect(resolved.model).toBe('claude-sonnet-4-5');
    expect(resolved.reason).toMatch(/override/);
  });

  it('resolves cloud-only to the configured cloud model', async () => {
    const engine = createAuraCodeEngine({ cloudModel: 'my-cloud-model' });
    const resolved = await engine.resolveModel({
      policy: { kind: 'cloud-only' },
      task: 'anything',
      projectRoot: '/proj',
    });
    expect(resolved).toMatchObject({ model: 'my-cloud-model', isLocal: false });
  });
});
