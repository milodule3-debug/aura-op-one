// The end-to-end acceptance scenario from the Aura OP One brief, run as one
// continuous story against a fake engine. Each numbered step is asserted.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { OpOneSession } from '../src/session.js';
import { agentStore, knowledgeStore, opOneEpisodeStore } from '../src/stores.js';
import { runCommand } from '../src/commands.js';
import { retrieve } from '../src/memory.js';
import { createFakeEngine } from './fake-engine.js';

let tmp: string;
let prevDir: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opone-e2e-'));
  prevDir = process.env.AURA_OP_ONE_DIR;
  process.env.AURA_OP_ONE_DIR = tmp;
});

afterEach(() => {
  if (prevDir === undefined) delete process.env.AURA_OP_ONE_DIR;
  else process.env.AURA_OP_ONE_DIR = prevDir;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('end-to-end acceptance scenario', () => {
  it('runs the full ten-step scenario', async () => {
    const projectRoot = '/proj/pagination-lib';

    // Prior verified experience, from an earlier session.
    knowledgeStore.save({
      text: 'pagination slice bounds in this project are inclusive of the offset',
      provenance: {
        source: 'episode:earlier',
        createdAt: '2026-01-01T00:00:00.000Z',
        confidence: 0.9,
        verification: 'verified',
        projectRoot,
      },
    });
    // Unverified chatter that must NOT outrank it, despite matching perfectly.
    opOneEpisodeStore.save({
      id: 'ep_rumour',
      at: new Date().toISOString(),
      projectRoot,
      request: 'pagination slice bounds offset',
      agentId: 'default',
      model: 'cloud-model',
      usedLocalModel: false,
      mode: 'local-agent',
      retrievedMemoryIds: [],
      summary: 'someone guessed the bounds were exclusive',
      verification: {
        state: 'rejected', decision: 'gate declined', checks: [],
        evidence: { toolCalls: [], filesChanged: [], testsExecuted: [] },
        at: new Date().toISOString(),
      },
      durationMs: 1,
      tokens: { input: 1, output: 1 },
    });

    // — 3. An agent is created and selected —
    const agent = agentStore.create({
      name: 'Fixer',
      purpose: 'Fixes small bugs in this project.',
      instruction: 'Fix the described bug with the smallest correct change, then run the tests.',
      permittedTools: ['read_file', 'search_code', 'edit_file', 'run_shell'],
      modelPolicy: { kind: 'local-first' },
      verificationPolicy: 'on-code-change',
      memoryScope: 'full',
    });

    const engine = createFakeEngine({
      localAvailable: true,
      verifyPasses: true,
      run: req =>
        req.task.startsWith('Commit')
          ? { summary: 'created commit 9f8e7d6', toolCalls: [] }
          : {
              summary: 'Corrected the slice bounds in src/paginate.ts; the suite passes.',
              toolCalls: [
                { name: 'read_file', input: { path: 'src/paginate.ts' } },
                { name: 'edit_file', input: { path: 'src/paginate.ts' } },
                { name: 'run_shell', input: { command: 'npm test' } },
              ],
            },
    });

    let approvalAsked = '';
    const session = new OpOneSession({
      engine,
      projectRoot,
      testCommand: 'npm test',
      confirm: async (message: string) => {
        approvalAsked = message;
        return true; // — 8. the user approves —
      },
    });
    session.setAgent(agent);
    expect(session.activeAgent().id).toBe(agent.id);

    // — 1. The user asks Aura OP One to improve a small project —
    const turn = await session.handle('the pagination helper drops the last page — fix it');

    // — 2. Relevant verified experience was retrieved, ranked above the rejected episode —
    expect(turn.retrieved.length).toBeGreaterThan(0);
    expect(turn.retrieved[0].record.category).toBe('knowledge');
    expect(turn.retrieved[0].record.provenance.verification).toBe('verified');
    const rejectedRank = turn.retrieved.findIndex(h => h.record.id === 'ep_rumour');
    expect(rejectedRank === -1 || rejectedRank > 0).toBe(true);
    expect(engine.runs[0].task).toContain('inclusive of the offset');

    // — 4. A model was selected through aura-code —
    expect(turn.model).toBe('local-model');
    expect(turn.usedLocalModel).toBe(true);

    // — 5. The agent performed the task under normal permissions —
    expect(engine.runs[0].allowedTools).toEqual(agent.permittedTools);
    expect(engine.runs[0].instruction).toBe(agent.instruction);

    // — 6. Verification evaluated the result AND its tool evidence —
    expect(engine.verifies).toHaveLength(1);
    expect(engine.verifies[0].toolCalls).toHaveLength(3);
    expect(turn.verification.evidence.filesChanged).toEqual(['src/paginate.ts']);
    expect(turn.verification.evidence.testsExecuted).toEqual(['npm test']);

    // — 7. The client displays the correct verification state —
    expect(turn.verification.state).toBe('verified');
    const status = await runCommand(session, ':status');
    expect(status.output).toContain('verified');

    // — 8. The user approves the commit —
    const commit = await session.commitLast('fix: include the last page in pagination');
    expect(approvalAsked).toContain('src/paginate.ts');
    expect(commit.committed).toBe(true);
    expect(commit.sha).toBe('9f8e7d6');

    // — 9. The episode and verification outcome are recorded with provenance —
    const stored = opOneEpisodeStore.get(turn.episode.id)!;
    expect(stored).toMatchObject({
      projectRoot,
      agentId: agent.id,
      model: 'local-model',
      usedLocalModel: true,
      mode: 'local-agent',
      commitApproved: true,
    });
    expect(stored.verification.state).toBe('verified');
    expect(stored.verification.evidence.commitSha).toBe('9f8e7d6');
    expect(stored.verification.checks.length).toBeGreaterThan(0);
    expect(stored.retrievedMemoryIds.length).toBeGreaterThan(0);
    expect(engine.episodes[0].verifierApproved).toBe(true);

    // — 10. A later related request retrieves that experience, provenance intact —
    const later = retrieve({
      query: 'pagination helper last page',
      scope: 'full',
      projectRoot,
    });
    const promoted = later.find(h => h.record.provenance.source === `episode:${turn.episode.id}`);
    expect(promoted).toBeDefined();
    expect(promoted!.record.provenance).toMatchObject({
      verification: 'verified',
      agentId: agent.id,
      projectRoot,
    });
    expect(promoted!.record.text).toContain('Corrected the slice bounds');
    expect(Date.parse(promoted!.record.provenance.createdAt)).not.toBeNaN();
  });

  it('a rejected run leaves nothing promoted for the next request to trust', async () => {
    const projectRoot = '/proj/other';
    const engine = createFakeEngine({
      verifyPasses: false,
      run: {
        summary: 'attempted a fix',
        toolCalls: [{ name: 'edit_file', input: { path: 'src/x.ts' } }],
      },
    });
    const session = new OpOneSession({ engine, projectRoot, confirm: async () => true });

    const turn = await session.handle('fix the widget');
    expect(turn.verification.state).toBe('rejected');

    // Not committable.
    const commit = await session.commitLast('fix: widget');
    expect(commit.committed).toBe(false);

    // Not promoted to the trusted tier.
    expect(knowledgeStore.list()).toHaveLength(0);

    // Still recalled as an episode — but never as verified.
    const later = retrieve({ query: 'fix the widget', scope: 'engineering', projectRoot });
    expect(later.every(h => h.record.provenance.verification !== 'verified')).toBe(true);
  });
});
