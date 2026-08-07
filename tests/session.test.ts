import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { OpOneSession } from '../src/session.js';
import {
  agentStore,
  conversationStore,
  knowledgeStore,
  opOneEpisodeStore,
  preferencesStore,
} from '../src/stores.js';
import { defaultAgent } from '../src/agent-schema.js';
import { createFakeEngine } from './fake-engine.js';
import type { MeshTransport } from '../src/mesh.js';

let tmp: string;
let prevDir: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opone-session-'));
  prevDir = process.env.AURA_OP_ONE_DIR;
  process.env.AURA_OP_ONE_DIR = tmp;
});

afterEach(() => {
  if (prevDir === undefined) delete process.env.AURA_OP_ONE_DIR;
  else process.env.AURA_OP_ONE_DIR = prevDir;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const EDIT = { name: 'edit_file', input: { path: 'src/a.ts' } };

describe('the canonical loop', () => {
  it('runs request → retrieve → select → act → verify → record', async () => {
    const engine = createFakeEngine({ run: { toolCalls: [EDIT] }, verifyPasses: true });
    const session = new OpOneSession({ engine, projectRoot: '/proj' });

    const turn = await session.handle('improve the pagination helper');

    expect(turn.reply).toBeTruthy();
    expect(turn.verification.state).toBe('verified');
    expect(turn.episode.request).toBe('improve the pagination helper');
    expect(turn.mode).toBe('local-agent');
    // Every step timed, so performance can be reported rather than claimed.
    expect(turn.timings.totalMs).toBeGreaterThanOrEqual(0);
    expect(turn.timings).toHaveProperty('retrievalMs');
    expect(turn.timings).toHaveProperty('verificationMs');
  });

  it('persists both sides of the conversation with agent, model and state', async () => {
    const engine = createFakeEngine({ run: { toolCalls: [EDIT] } });
    const session = new OpOneSession({ engine, projectRoot: '/proj' });
    await session.handle('do a thing');

    const conv = conversationStore.get(session.conversationId)!;
    expect(conv.turns.map(t => t.role)).toEqual(['user', 'assistant']);
    expect(conv.turns[1].agentId).toBe('default');
    expect(conv.turns[1].model).toBe('local-model');
    expect(conv.turns[1].verification).toBe('verified');
  });

  it('resumes an existing conversation', async () => {
    const engine = createFakeEngine();
    const first = new OpOneSession({ engine, projectRoot: '/proj' });
    await first.handle('first message');

    const resumed = new OpOneSession({
      engine, projectRoot: '/proj', conversationId: first.conversationId,
    });
    await resumed.handle('second message');

    expect(conversationStore.get(first.conversationId)!.turns).toHaveLength(4);
  });

  it('records the episode with provenance in both stores', async () => {
    const engine = createFakeEngine({ run: { toolCalls: [EDIT] } });
    const session = new OpOneSession({ engine, projectRoot: '/proj' });
    const turn = await session.handle('fix the parser');

    const stored = opOneEpisodeStore.get(turn.episode.id)!;
    expect(stored.agentId).toBe('default');
    expect(stored.model).toBe('local-model');
    expect(stored.usedLocalModel).toBe(true);
    expect(stored.verification.state).toBe('verified');

    // Mirrored into aura-code's own store so competence learns from it.
    expect(engine.episodes).toHaveLength(1);
    expect(engine.episodes[0].verifierApproved).toBe(true);
  });

  it('feeds retrieved experience into the agent task, with provenance', async () => {
    knowledgeStore.save({
      text: 'pagination bounds are inclusive in this codebase',
      provenance: {
        source: 'episode:old', createdAt: new Date().toISOString(),
        confidence: 0.9, verification: 'verified', projectRoot: '/proj',
      },
    });

    const engine = createFakeEngine();
    const session = new OpOneSession({ engine, projectRoot: '/proj' });
    await session.handle('fix pagination bounds');

    expect(engine.runs[0].task).toContain('[verified]');
    expect(engine.runs[0].task).toContain('pagination bounds are inclusive');
  });
});

describe('verification policy', () => {
  it('"always" verifies even when nothing was touched', async () => {
    agentStore.create({ ...defaultAgent(), id: 'strict', verificationPolicy: 'always' });
    const engine = createFakeEngine({ run: { toolCalls: [] } });
    const session = new OpOneSession({ engine, projectRoot: '/proj' });
    session.setAgent(agentStore.get('strict')!);

    const turn = await session.handle('just answer a question');
    expect(turn.verification.state).toBe('verified');
    expect(engine.verifies).toHaveLength(1);
  });

  it('"on-code-change" leaves a non-code turn unverified rather than implying a pass', async () => {
    const engine = createFakeEngine({ run: { toolCalls: [{ name: 'read_file', input: { path: 'a' } }] } });
    const session = new OpOneSession({ engine, projectRoot: '/proj' });

    const turn = await session.handle('what does this file do');
    expect(turn.verification.state).toBe('unverified');
    expect(engine.verifies).toHaveLength(0);
  });

  it('"manual" never verifies until asked', async () => {
    agentStore.create({ ...defaultAgent(), id: 'lazy', verificationPolicy: 'manual' });
    const engine = createFakeEngine({ run: { toolCalls: [EDIT] } });
    const session = new OpOneSession({ engine, projectRoot: '/proj' });
    session.setAgent(agentStore.get('lazy')!);

    const turn = await session.handle('edit something');
    expect(turn.verification.state).toBe('unverified');

    const verified = await session.verifyLast();
    expect(verified?.state).toBe('verified');
  });
});

describe('rejected output handling', () => {
  it('marks a turn rejected and does not promote it to knowledge', async () => {
    const engine = createFakeEngine({ run: { toolCalls: [EDIT] }, verifyPasses: false });
    const session = new OpOneSession({ engine, projectRoot: '/proj' });

    const turn = await session.handle('break something');
    expect(turn.verification.state).toBe('rejected');
    expect(knowledgeStore.list()).toHaveLength(0);
  });

  it('still records a rejected episode — a failure is experience too', async () => {
    const engine = createFakeEngine({ run: { toolCalls: [EDIT] }, verifyPasses: false });
    const session = new OpOneSession({ engine, projectRoot: '/proj' });
    const turn = await session.handle('break something');

    expect(opOneEpisodeStore.get(turn.episode.id)?.verification.state).toBe('rejected');
    expect(engine.episodes[0].verifierApproved).toBe(false);
  });

  it('escalates without promoting when the gate cannot run', async () => {
    const engine = createFakeEngine({ run: { toolCalls: [EDIT] }, verifyThrows: true });
    const session = new OpOneSession({ engine, projectRoot: '/proj' });

    const turn = await session.handle('do something');
    expect(turn.verification.state).toBe('escalated');
    expect(knowledgeStore.list()).toHaveLength(0);
  });
});

describe('local/cloud model switching', () => {
  it('uses the local model under local-first when it is available', async () => {
    const engine = createFakeEngine({ localAvailable: true });
    const session = new OpOneSession({ engine, projectRoot: '/proj' });
    const turn = await session.handle('a task');
    expect(turn.usedLocalModel).toBe(true);
    expect(turn.model).toBe('local-model');
  });

  it('falls back to cloud when the local model is unreachable, and records it', async () => {
    const engine = createFakeEngine({ localAvailable: false });
    const session = new OpOneSession({ engine, projectRoot: '/proj' });
    const turn = await session.handle('a task');

    expect(turn.usedLocalModel).toBe(false);
    expect(turn.model).toBe('cloud-model');
    expect(turn.fallback).toMatchObject({ to: 'cloud-model', reason: 'local model unreachable' });
    expect(opOneEpisodeStore.get(turn.episode.id)?.fallback?.reason).toBe('local model unreachable');
  });

  it('honours a cloud-only agent policy', async () => {
    agentStore.create({ ...defaultAgent(), id: 'cloudy', modelPolicy: { kind: 'cloud-only' } });
    const engine = createFakeEngine();
    const session = new OpOneSession({ engine, projectRoot: '/proj' });
    session.setAgent(agentStore.get('cloudy')!);

    const turn = await session.handle('a task');
    expect(turn.usedLocalModel).toBe(false);
  });

  it('lets a :model override win over the agent policy', async () => {
    const engine = createFakeEngine();
    const session = new OpOneSession({ engine, projectRoot: '/proj' });
    session.setModelOverride('gpt-4o');

    const turn = await session.handle('a task');
    expect(turn.model).toBe('gpt-4o');
    // Persisted, so the override survives a restart.
    expect(preferencesStore.load().preferredModel).toBe('gpt-4o');
  });
});

describe('mesh execution through the session', () => {
  const meshTransport: MeshTransport = {
    name: 'test-mesh',
    async available() { return true; },
    async execute() {
      return { success: true, summary: 'mesh result', toolCalls: [EDIT] };
    },
  };

  it('does not use the mesh by default even when asked', async () => {
    const engine = createFakeEngine();
    const session = new OpOneSession({ engine, projectRoot: '/proj', meshTransport });

    const turn = await session.handle('delegate this', { mesh: true });
    expect(turn.mode).toBe('local-agent');
  });

  it('uses the mesh once enabled and explicitly requested', async () => {
    const engine = createFakeEngine();
    const session = new OpOneSession({ engine, projectRoot: '/proj', meshTransport });
    session.setMeshEnabled(true);

    const turn = await session.handle('delegate this', { mesh: true });
    expect(turn.mode).toBe('mesh');
    expect(turn.reply).toContain('mesh result');
  });

  it('verifies mesh output through the same gate — no shortcut to verified', async () => {
    const engine = createFakeEngine({ verifyPasses: false });
    const session = new OpOneSession({ engine, projectRoot: '/proj', meshTransport });
    session.setMeshEnabled(true);

    const turn = await session.handle('delegate this', { mesh: true });
    expect(turn.mode).toBe('mesh');
    expect(turn.verification.state).toBe('rejected');
    expect(engine.verifies).toHaveLength(1);
  });

  it('records episodes for mesh work like any other', async () => {
    const engine = createFakeEngine();
    const session = new OpOneSession({ engine, projectRoot: '/proj', meshTransport });
    session.setMeshEnabled(true);

    const turn = await session.handle('delegate this', { mesh: true });
    expect(opOneEpisodeStore.get(turn.episode.id)?.mode).toBe('mesh');
  });
});

describe('the commit gate in a session', () => {
  it('does not commit without user approval, even when verified', async () => {
    const engine = createFakeEngine({ run: { toolCalls: [EDIT] }, verifyPasses: true });
    // No `confirm` supplied — the default refuses.
    const session = new OpOneSession({ engine, projectRoot: '/proj' });
    await session.handle('change a file');

    const result = await session.commitLast('fix: pagination');
    expect(result.committed).toBe(false);
    expect(result.reason).toMatch(/has not approved/);
  });

  it('does not commit unverified work even with user approval', async () => {
    const engine = createFakeEngine({ run: { toolCalls: [EDIT] }, verifyPasses: false });
    const session = new OpOneSession({
      engine, projectRoot: '/proj', confirm: async () => true,
    });
    await session.handle('change a file');

    const result = await session.commitLast('fix: thing');
    expect(result.committed).toBe(false);
    expect(result.reason).toMatch(/only verified changes/);
  });

  it('commits when verified and approved, recording the SHA in the audit trail', async () => {
    const engine = createFakeEngine({
      run: req =>
        req.task.startsWith('Commit')
          ? { summary: 'committed as a1b2c3d4', toolCalls: [] }
          : { toolCalls: [EDIT] },
      verifyPasses: true,
    });
    const session = new OpOneSession({
      engine, projectRoot: '/proj', confirm: async () => true,
    });
    const turn = await session.handle('change a file');

    const result = await session.commitLast('fix: pagination');
    expect(result.committed).toBe(true);
    expect(result.sha).toBe('a1b2c3d4');

    const stored = opOneEpisodeStore.get(turn.episode.id)!;
    expect(stored.commitApproved).toBe(true);
    expect(stored.verification.evidence.commitSha).toBe('a1b2c3d4');
  });

  it('respects a permission denial on git', async () => {
    const engine = createFakeEngine({
      run: { toolCalls: [EDIT] }, verifyPasses: true, deniedTools: ['git'],
    });
    const session = new OpOneSession({
      engine, projectRoot: '/proj', confirm: async () => true,
    });
    await session.handle('change a file');

    const result = await session.commitLast('fix: thing');
    expect(result.committed).toBe(false);
    expect(result.reason).toMatch(/denied/);
  });
});

describe('agent selection', () => {
  it('uses the preferred agent from preferences on construction', async () => {
    agentStore.create({ ...defaultAgent(), id: 'reviewer', name: 'Reviewer' });
    preferencesStore.update({ defaultAgentId: 'reviewer' });

    const session = new OpOneSession({ engine: createFakeEngine(), projectRoot: '/proj' });
    expect(session.activeAgent().id).toBe('reviewer');
  });

  it('falls back to the built-in default when no agent exists', () => {
    const session = new OpOneSession({ engine: createFakeEngine(), projectRoot: '/proj' });
    expect(session.activeAgent().id).toBe('default');
  });

  it('passes the agent instruction and tool grant to the engine', async () => {
    agentStore.create({
      ...defaultAgent(),
      id: 'reader',
      instruction: 'Only read.',
      permittedTools: ['read_file'],
    });
    const engine = createFakeEngine();
    const session = new OpOneSession({ engine, projectRoot: '/proj' });
    session.setAgent(agentStore.get('reader')!);

    await session.handle('look at things');
    expect(engine.runs[0].instruction).toBe('Only read.');
    expect(engine.runs[0].allowedTools).toEqual(['read_file']);
  });
});
