import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  retrieve,
  rank,
  collectCandidates,
  tierFor,
  matchScore,
  formatForPrompt,
  promoteToKnowledge,
} from '../src/memory.js';
import {
  knowledgeStore,
  conversationStore,
  preferencesStore,
  opOneEpisodeStore,
} from '../src/stores.js';
import type { OpOneEpisode, Provenance, MemoryRecord } from '../src/types.js';

let tmp: string;
let prevDir: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opone-mem-'));
  prevDir = process.env.AURA_OP_ONE_DIR;
  process.env.AURA_OP_ONE_DIR = tmp;
});

afterEach(() => {
  if (prevDir === undefined) delete process.env.AURA_OP_ONE_DIR;
  else process.env.AURA_OP_ONE_DIR = prevDir;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function prov(over: Partial<Provenance> = {}): Provenance {
  return {
    source: 'test',
    createdAt: new Date().toISOString(),
    confidence: 0.9,
    verification: 'verified',
    projectRoot: '/proj',
    ...over,
  };
}

function episode(over: Partial<OpOneEpisode> = {}): OpOneEpisode {
  return {
    id: `ep_${Math.random().toString(36).slice(2)}`,
    at: new Date().toISOString(),
    projectRoot: '/proj',
    request: 'pagination off-by-one',
    agentId: 'default',
    model: 'local-model',
    usedLocalModel: true,
    mode: 'local-agent',
    retrievedMemoryIds: [],
    summary: 'fixed the pagination slice bounds',
    verification: {
      state: 'verified',
      decision: 'ok',
      checks: [],
      evidence: { toolCalls: [], filesChanged: [], testsExecuted: [] },
      at: new Date().toISOString(),
    },
    durationMs: 5,
    tokens: { input: 1, output: 1 },
    ...over,
  };
}

describe('memory separation', () => {
  it('reads the six categories from separate stores, never one merged blob', () => {
    knowledgeStore.save({ text: 'pagination bounds are inclusive here', provenance: prov() });
    opOneEpisodeStore.save(episode());
    preferencesStore.update({ notes: ['prefers concise answers'] });
    const conv = conversationStore.create();
    conversationStore.append(conv.id, {
      role: 'user',
      content: 'pagination question',
      at: new Date().toISOString(),
    });

    const candidates = collectCandidates({
      query: 'pagination',
      scope: 'full',
      projectRoot: '/proj',
      conversationId: conv.id,
    });

    const categories = new Set(candidates.map(c => c.category));
    expect(categories).toContain('knowledge');
    expect(categories).toContain('episode');
    expect(categories).toContain('preference');
    expect(categories).toContain('conversation');
  });

  it('the "engineering" scope excludes personal content entirely', () => {
    preferencesStore.update({ notes: ['lives in Belgrade'] });
    const conv = conversationStore.create();
    conversationStore.append(conv.id, {
      role: 'user',
      content: 'my personal secret plan',
      at: new Date().toISOString(),
    });
    opOneEpisodeStore.save(episode());

    const candidates = collectCandidates({
      query: 'pagination plan Belgrade',
      scope: 'engineering',
      projectRoot: '/proj',
      conversationId: conv.id,
    });

    const categories = new Set(candidates.map(c => c.category));
    expect(categories).not.toContain('preference');
    expect(categories).not.toContain('conversation');
    expect(categories).toContain('episode');
  });

  it('the "none" scope retrieves nothing', () => {
    opOneEpisodeStore.save(episode());
    expect(collectCandidates({ query: 'pagination', scope: 'none' })).toHaveLength(0);
  });

  it('scopes episodes and knowledge to the project', () => {
    opOneEpisodeStore.save(episode({ projectRoot: '/other', request: 'pagination elsewhere' }));
    opOneEpisodeStore.save(episode({ projectRoot: '/proj' }));
    const candidates = collectCandidates({ query: 'pagination', projectRoot: '/proj', scope: 'engineering' });
    expect(candidates.every(c => c.provenance.projectRoot === '/proj')).toBe(true);
  });
});

describe('ranking', () => {
  it('ranks verified engineering experience above unverified conversation, regardless of match', () => {
    // The conversation turn is a perfect textual match and brand new; the
    // verified knowledge is a weaker match and older. Verified must still win.
    const records: MemoryRecord[] = [
      {
        id: 'chat',
        category: 'conversation',
        text: 'pagination bounds slice offset limit exactly',
        provenance: prov({ verification: 'unverified', confidence: 0.3, createdAt: new Date().toISOString() }),
      },
      {
        id: 'know',
        category: 'knowledge',
        text: 'pagination bounds',
        provenance: prov({ verification: 'verified', confidence: 0.5, createdAt: '2020-01-01T00:00:00.000Z' }),
      },
    ];

    const ranked = rank('pagination bounds slice offset limit exactly', records);
    expect(ranked[0].record.id).toBe('know');
  });

  it('ranks an unverified episode above conversation but below verified knowledge', () => {
    const records: MemoryRecord[] = [
      { id: 'chat', category: 'conversation', text: 'cache tokens', provenance: prov({ verification: 'unverified' }) },
      { id: 'ep', category: 'episode', text: 'cache tokens', provenance: prov({ verification: 'rejected' }) },
      { id: 'kn', category: 'knowledge', text: 'cache tokens', provenance: prov({ verification: 'verified' }) },
    ];
    expect(rank('cache tokens', records).map(h => h.record.id)).toEqual(['kn', 'ep', 'chat']);
  });

  it('keeps preferences retrievable even with no textual overlap', () => {
    preferencesStore.update({ notes: ['always prefers TypeScript'] });
    const hits = retrieve({ query: 'completely unrelated topic', scope: 'full' });
    expect(hits.some(h => h.record.category === 'preference')).toBe(true);
  });

  it('drops non-preference records with no overlap at all', () => {
    opOneEpisodeStore.save(episode({ request: 'pagination', summary: 'pagination' }));
    const hits = retrieve({ query: 'zzzzz nothing matches', scope: 'engineering', projectRoot: '/proj' });
    expect(hits).toHaveLength(0);
  });

  it('scores token overlap in [0,1]', () => {
    expect(matchScore('cache the token', 'cache the token')).toBe(1);
    expect(matchScore('cache the token', 'nothing similar')).toBe(0);
    expect(matchScore('', 'anything')).toBe(0);
  });

  it('labels the tier it used, so ranking is inspectable', () => {
    const verified = tierFor({
      id: 'k', category: 'knowledge', text: 't', provenance: prov({ verification: 'verified' }),
    });
    expect(verified.label).toBe('verified engineering experience');
    const chat = tierFor({
      id: 'c', category: 'conversation', text: 't', provenance: prov({ verification: 'unverified' }),
    });
    expect(chat.tier).toBeLessThan(verified.tier);
  });
});

describe('provenance preservation', () => {
  it('carries source, time, confidence, verification and project through retrieval', () => {
    knowledgeStore.save({
      text: 'the retry budget is four attempts',
      provenance: prov({ source: 'episode:ep_9', confidence: 0.77, agentId: 'reviewer' }),
    });

    const [hit] = retrieve({ query: 'retry budget attempts', scope: 'engineering', projectRoot: '/proj' });
    expect(hit.record.provenance).toMatchObject({
      source: 'episode:ep_9',
      confidence: 0.77,
      verification: 'verified',
      agentId: 'reviewer',
      projectRoot: '/proj',
    });
    expect(Date.parse(hit.record.provenance.createdAt)).not.toBeNaN();
  });

  it('renders verification state into the prompt so the distinction survives', () => {
    knowledgeStore.save({ text: 'verified fact about retries', provenance: prov() });
    opOneEpisodeStore.save(episode({ request: 'retries', summary: 'unsure', verification: {
      state: 'unverified', decision: 'n/a', checks: [],
      evidence: { toolCalls: [], filesChanged: [], testsExecuted: [] },
      at: new Date().toISOString(),
    } }));

    const text = formatForPrompt(retrieve({ query: 'retries verified fact', scope: 'engineering', projectRoot: '/proj' }));
    expect(text).toContain('[verified]');
    expect(text).toMatch(/verified items are evidence/);
  });

  it('formats to empty when nothing was retrieved', () => {
    expect(formatForPrompt([])).toBe('');
  });
});

describe('promotion to reusable knowledge', () => {
  it('promotes a verified outcome', () => {
    expect(promoteToKnowledge('a verified lesson', prov({ verification: 'verified' }))).toBe(true);
    expect(knowledgeStore.list()).toHaveLength(1);
  });

  it('refuses to promote anything the gate did not approve', () => {
    for (const state of ['unverified', 'rejected', 'escalated', 'verification_pending'] as const) {
      expect(promoteToKnowledge('x', prov({ verification: state }))).toBe(false);
    }
    expect(knowledgeStore.list()).toHaveLength(0);
  });
});
