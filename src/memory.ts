// ─────────────────────────────────────────────────────────────────────────────
// Aura OP One — memory retrieval
// ─────────────────────────────────────────────────────────────────────────────
//
// Reads across the six separate stores and returns ranked hits. The stores stay
// separate on disk (architecture §7); this module is the only place they are
// considered together, and it never merges them — each hit keeps the category
// and the provenance it came with.
//
// The rule that governs ranking:
//
//   Verified engineering experience outranks unverified conversation content,
//   always — regardless of recency or textual match score.
//
// This is enforced by a tier that dominates the score rather than by weights
// that merely favour it, so no amount of keyword overlap can float a chat turn
// above a verified episode.

import type {
  MemoryRecord,
  MemoryCategory,
  RetrievalHit,
  MemoryScope,
  Provenance,
} from './types.js';
import {
  conversationStore,
  knowledgeStore,
  opOneEpisodeStore,
  preferencesStore,
} from './stores.js';

/** Tier weights. The gap between tiers exceeds any achievable match score. */
const TIER = {
  /** Verified knowledge and verified episodes. */
  verified: 1_000_000,
  /** Preferences — durable and user-stated, but not engineering evidence. */
  preference: 100_000,
  /** Unverified engineering episodes. */
  unverifiedEpisode: 10_000,
  /** Conversation content. */
  conversation: 1_000,
} as const;

export interface RetrieveOptions {
  /** The request being answered. */
  query: string;
  /** Restricts which categories may be read. */
  scope?: MemoryScope;
  /** Maximum hits returned. */
  limit?: number;
  /** Restricts episodes/knowledge to one project. */
  projectRoot?: string;
  /** Conversation to draw history from. */
  conversationId?: string;
}

/**
 * Collects candidate records from the stores permitted by `scope`.
 *
 * `engineering` scope deliberately excludes conversation and preferences: an
 * agent scoped that way must not see personal content, which is the separation
 * the six-category split exists to make enforceable.
 */
export function collectCandidates(opts: RetrieveOptions): MemoryRecord[] {
  const scope = opts.scope ?? 'full';
  if (scope === 'none') return [];

  const records: MemoryRecord[] = [];

  // — 4. Verified reusable knowledge —
  for (const k of knowledgeStore.list()) {
    if (opts.projectRoot && k.provenance.projectRoot && k.provenance.projectRoot !== opts.projectRoot) {
      continue;
    }
    records.push({ id: k.id, category: 'knowledge', text: k.text, provenance: k.provenance });
  }

  // — 3. Engineering episodes —
  for (const e of opOneEpisodeStore.list()) {
    if (opts.projectRoot && e.projectRoot !== opts.projectRoot) continue;
    records.push({
      id: e.id,
      category: 'episode',
      text: `${e.request}\n${e.summary}`,
      provenance: {
        source: `episode:${e.id}`,
        createdAt: e.at,
        // An episode's confidence follows its verdict: a rejected episode is
        // still worth recalling ("we tried this and it failed"), but weakly.
        confidence: e.verification.state === 'verified' ? 0.9 : 0.4,
        verification: e.verification.state,
        agentId: e.agentId,
        projectRoot: e.projectRoot,
      },
    });
  }

  if (scope === 'engineering') return records;

  // — 2. Personal preferences —
  const prefs = preferencesStore.load();
  for (const [i, note] of prefs.notes.entries()) {
    records.push({
      id: `pref_${i}`,
      category: 'preference',
      text: note,
      provenance: {
        source: 'preferences',
        createdAt: prefs.updatedAt,
        confidence: 1,
        // A stated preference is not an engineering claim, so it is never
        // "verified" — it is simply true of the user.
        verification: 'unverified',
      },
    });
  }

  // — 1. Conversation history —
  if (opts.conversationId) {
    const conv = conversationStore.get(opts.conversationId);
    for (const [i, turn] of (conv?.turns ?? []).entries()) {
      records.push({
        id: `${opts.conversationId}#${i}`,
        category: 'conversation',
        text: turn.content,
        provenance: {
          source: `conversation:${opts.conversationId}`,
          createdAt: turn.at,
          confidence: 0.3,
          verification: turn.verification ?? 'unverified',
          agentId: turn.agentId,
        },
      });
    }
  }

  return records;
}

/** Tier for a record — the dominant term in its score. */
export function tierFor(record: MemoryRecord): { tier: number; label: string } {
  const verified = record.provenance.verification === 'verified';

  if (verified && (record.category === 'knowledge' || record.category === 'episode')) {
    return { tier: TIER.verified, label: 'verified engineering experience' };
  }
  if (record.category === 'preference') {
    return { tier: TIER.preference, label: 'personal preference' };
  }
  if (record.category === 'episode' || record.category === 'knowledge') {
    return { tier: TIER.unverifiedEpisode, label: `unverified ${record.category}` };
  }
  return { tier: TIER.conversation, label: 'conversation' };
}

/** Token overlap between query and record text, in [0, 1]. */
export function matchScore(query: string, text: string): number {
  const q = tokenize(query);
  if (q.size === 0) return 0;
  const t = tokenize(text);
  let hits = 0;
  for (const token of q) if (t.has(token)) hits++;
  return hits / q.size;
}

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(w => w.length > 2),
  );
}

/**
 * Ranks candidates. Score = tier + match + confidence + a small recency nudge.
 *
 * Every term after `tier` is bounded well below the gap between tiers, so
 * ordering *between* tiers is fixed and those terms only order *within* one.
 */
export function rank(query: string, records: MemoryRecord[], now = Date.now()): RetrievalHit[] {
  return records
    .map(record => {
      const { tier, label } = tierFor(record);
      const match = matchScore(query, record.text);
      const confidence = record.provenance.confidence;
      const ageDays = Math.max(
        0,
        (now - Date.parse(record.provenance.createdAt || '0')) / 86_400_000,
      );
      const recency = Number.isFinite(ageDays) ? 1 / (1 + ageDays) : 0;

      const score = tier + match * 100 + confidence * 10 + recency;

      return {
        record,
        score,
        reason:
          `${label} · match ${(match * 100).toFixed(0)}% · ` +
          `confidence ${confidence.toFixed(2)} · ${record.provenance.verification}`,
      };
    })
    // Drop records with nothing in common with the query, except preferences,
    // which apply to every request by definition.
    .filter(h => h.record.category === 'preference' || matchScore(query, h.record.text) > 0)
    .sort((a, b) => b.score - a.score);
}

/** Retrieves ranked experience for a request, provenance intact. */
export function retrieve(opts: RetrieveOptions): RetrievalHit[] {
  const hits = rank(opts.query, collectCandidates(opts));
  return hits.slice(0, opts.limit ?? 8);
}

/**
 * Renders retrieved experience for the agent prompt.
 *
 * Provenance is rendered inline rather than stripped: the agent is told which
 * lines are verified evidence and which are recollection, so the distinction
 * survives into the model's context instead of dying at the retrieval boundary.
 */
export function formatForPrompt(hits: RetrievalHit[]): string {
  if (hits.length === 0) return '';
  const lines = hits.map(h => {
    const p = h.record.provenance;
    return `- [${p.verification}] (${h.record.category}, confidence ${p.confidence.toFixed(2)}, ${p.createdAt}) ${h.record.text.slice(0, 300)}`;
  });
  return `Relevant prior experience (verified items are evidence; unverified items are recollection and may be wrong):\n${lines.join('\n')}`;
}

/**
 * Promotes a verified outcome into reusable knowledge — step 7 of the canonical
 * loop. Refuses anything not verified, so the knowledge store stays the one
 * trustworthy tier.
 */
export function promoteToKnowledge(text: string, provenance: Provenance): boolean {
  if (provenance.verification !== 'verified') return false;
  knowledgeStore.save({ text, provenance });
  return true;
}

export type { MemoryCategory };
