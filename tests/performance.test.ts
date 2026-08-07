// Performance measurement for the layers Aura OP One actually owns.
//
// The engine is faked, so these numbers isolate the CLIENT's overhead —
// retrieval, ranking, verification bookkeeping, store I/O, episode recording —
// from provider latency, which belongs to aura-code and varies by model.
//
// Numbers are printed rather than asserted tightly: the assertions here are
// generous ceilings that catch a regression into "this layer is now the
// bottleneck", not micro-benchmarks that flake on a loaded CI box.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { OpOneSession } from '../src/session.js';
import { knowledgeStore, opOneEpisodeStore, conversationStore } from '../src/stores.js';
import { retrieve } from '../src/memory.js';
import { createFakeEngine } from './fake-engine.js';
import type { OpOneEpisode } from '../src/types.js';

let tmp: string;
let prevDir: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opone-perf-'));
  prevDir = process.env.AURA_OP_ONE_DIR;
  process.env.AURA_OP_ONE_DIR = tmp;
});

afterEach(() => {
  if (prevDir === undefined) delete process.env.AURA_OP_ONE_DIR;
  else process.env.AURA_OP_ONE_DIR = prevDir;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const measurements: Array<{ what: string; value: string }> = [];

function record(what: string, value: string) {
  measurements.push({ what, value });
  console.log(`  ${what.padEnd(46)} ${value}`);
}

function seedMemory(count: number, projectRoot: string) {
  for (let i = 0; i < count; i++) {
    knowledgeStore.save({
      text: `verified lesson ${i} about pagination bounds and retry budgets in module ${i}`,
      provenance: {
        source: `episode:seed_${i}`,
        createdAt: new Date(Date.now() - i * 3600_000).toISOString(),
        confidence: 0.9,
        verification: 'verified',
        projectRoot,
      },
    });
  }
}

function seedEpisodes(count: number, projectRoot: string) {
  for (let i = 0; i < count; i++) {
    const ep: OpOneEpisode = {
      id: `seed_ep_${i}`,
      at: new Date(Date.now() - i * 3600_000).toISOString(),
      projectRoot,
      request: `earlier request ${i} about pagination`,
      agentId: 'default',
      model: 'local-model',
      usedLocalModel: true,
      mode: 'local-agent',
      retrievedMemoryIds: [],
      summary: `summary ${i}`,
      verification: {
        state: i % 2 === 0 ? 'verified' : 'rejected',
        decision: 'seed',
        checks: [],
        evidence: { toolCalls: [], filesChanged: [], testsExecuted: [] },
        at: new Date().toISOString(),
      },
      durationMs: 10,
      tokens: { input: 10, output: 5 },
    };
    opOneEpisodeStore.save(ep);
  }
}

describe('Aura OP One performance', () => {
  it('measures startup: module load and session construction', async () => {
    const t0 = performance.now();
    // Fresh import cost is what a cold CLI start pays for the client layer.
    await import('../src/index.js');
    const importMs = performance.now() - t0;

    const t1 = performance.now();
    const session = new OpOneSession({ engine: createFakeEngine(), projectRoot: '/proj' });
    const constructMs = performance.now() - t1;

    record('client module load', `${importMs.toFixed(1)} ms`);
    record('session construction (stores + agent resolve)', `${constructMs.toFixed(1)} ms`);
    expect(session.activeAgent()).toBeDefined();
    expect(constructMs).toBeLessThan(500);
  });

  it('measures memory-retrieval overhead against a populated store', () => {
    const projectRoot = '/proj';
    seedMemory(200, projectRoot);
    seedEpisodes(200, projectRoot);

    // Warm the filesystem cache so this measures ranking, not first-read I/O.
    retrieve({ query: 'pagination bounds', scope: 'full', projectRoot });

    const runs = 20;
    const t0 = performance.now();
    for (let i = 0; i < runs; i++) {
      retrieve({ query: 'pagination bounds retry budget', scope: 'full', projectRoot });
    }
    const perCall = (performance.now() - t0) / runs;

    record('memory retrieval (400 records, ranked)', `${perCall.toFixed(1)} ms/call`);
    expect(perCall).toBeLessThan(250);
  });

  it('measures the client overhead of one full turn', async () => {
    const projectRoot = '/proj';
    seedMemory(50, projectRoot);
    seedEpisodes(50, projectRoot);

    const engine = createFakeEngine({
      verifyPasses: true,
      run: {
        summary: 'did the work',
        toolCalls: [
          { name: 'edit_file', input: { path: 'a.ts' } },
          { name: 'run_shell', input: { command: 'npm test' } },
        ],
        tokens: { input: 1200, output: 300 },
      },
    });
    const session = new OpOneSession({ engine, projectRoot, testCommand: 'npm test' });

    const turn = await session.handle('fix the pagination bounds');
    const t = turn.timings;

    record('  retrieval', `${t.retrievalMs} ms`);
    record('  model selection', `${t.modelSelectionMs} ms`);
    record('  execution (faked engine — client overhead only)', `${t.executionMs} ms`);
    record('  verification bookkeeping', `${t.verificationMs} ms`);
    record('  episode recording', `${t.recordingMs} ms`);
    record('total turn (excluding real provider latency)', `${t.totalMs} ms`);
    record('tokens reported', `${turn.episode.tokens.input} in / ${turn.episode.tokens.output} out`);
    record('local model calls', String(turn.usedLocalModel ? 1 : 0));
    record('cloud model calls', String(turn.usedLocalModel ? 0 : 1));

    // The client layer must stay small next to a real model call (~1-10s).
    expect(t.totalMs).toBeLessThan(2000);
  });

  it('measures conversation persistence cost as history grows', () => {
    const conv = conversationStore.create();
    for (let i = 0; i < 50; i++) {
      conversationStore.append(conv.id, {
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `turn ${i} of a reasonably sized message about pagination and retries`,
        at: new Date().toISOString(),
      });
    }

    const t0 = performance.now();
    for (let i = 0; i < 10; i++) {
      conversationStore.append(conv.id, {
        role: 'user',
        content: 'another turn',
        at: new Date().toISOString(),
      });
    }
    const perAppend = (performance.now() - t0) / 10;

    record('conversation append (60-turn history)', `${perAppend.toFixed(1)} ms/turn`);
    expect(perAppend).toBeLessThan(100);
  });

  it('prints the collected measurements', () => {
    console.log('\n  — measured on this machine, fake engine, no network —');
    expect(measurements.length).toBeGreaterThan(0);
  });
});
