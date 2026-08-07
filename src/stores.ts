// ─────────────────────────────────────────────────────────────────────────────
// Aura OP One — storage
// ─────────────────────────────────────────────────────────────────────────────
//
// Six categories, six stores (architecture §7). Nothing is merged into one
// undifferentiated memory: personal preferences and engineering knowledge live
// in different files with different lifetimes, and the retrieval layer
// (./memory.ts) reads them separately so it can rank verified engineering
// experience above unverified chat.
//
// All writes are atomic (.tmp + rename), mirroring aura-code's sessionStore.

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type {
  AgentDefinition,
  Conversation,
  ConversationTurn,
  Preferences,
  OpOneEpisode,
  Provenance,
} from './types.js';
import { DEFAULT_PREFERENCES } from './types.js';
import { validateAgent, AgentSchemaError } from './agent-schema.js';
import { redactSecrets, redactValue } from './redact.js';

/** Root of everything Aura OP One owns. Overridable for tests. */
export function opOneRoot(): string {
  return (
    process.env.AURA_OP_ONE_DIR ??
    path.join(process.env.HOME ?? '/tmp', '.aura', 'op-one')
  );
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** Atomic JSON write. */
function writeJson(filePath: string, data: unknown): void {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

/** Reads JSON, returning `fallback` on missing or corrupt files. */
function readJson<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(4).toString('hex')}${Date.now().toString(36)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Agent definitions
// ─────────────────────────────────────────────────────────────────────────────

export const agentStore = {
  dir(): string {
    return path.join(opOneRoot(), 'agents');
  },

  filePath(id: string): string {
    return path.join(this.dir(), `${id}.json`);
  },

  /**
   * Persists an agent after schema validation. Invalid definitions are rejected
   * at the boundary rather than stored and failing later at execution time.
   */
  save(agent: AgentDefinition): AgentDefinition {
    const validated = validateAgent(agent);
    writeJson(this.filePath(validated.id), validated);
    return validated;
  },

  /** Creates a new agent from partial input, filling id and timestamp. */
  create(input: Omit<AgentDefinition, 'id' | 'createdAt'> & { id?: string }): AgentDefinition {
    return this.save({
      ...input,
      id: input.id ?? newId('agent'),
      createdAt: new Date().toISOString(),
    } as AgentDefinition);
  },

  get(id: string): AgentDefinition | undefined {
    const raw = readJson<AgentDefinition | null>(this.filePath(id), null);
    if (!raw) return undefined;
    try {
      return validateAgent(raw);
    } catch (e) {
      if (e instanceof AgentSchemaError) return undefined;
      throw e;
    }
  },

  list(): AgentDefinition[] {
    const dir = this.dir();
    if (!fs.existsSync(dir)) return [];
    const out: AgentDefinition[] = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const raw = readJson<AgentDefinition | null>(path.join(dir, f), null);
      if (!raw) continue;
      try {
        out.push(validateAgent(raw));
      } catch {
        // A corrupt definition is skipped, not fatal — the rest stay usable.
      }
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  },

  delete(id: string): boolean {
    const p = this.filePath(id);
    if (!fs.existsSync(p)) return false;
    fs.unlinkSync(p);
    return true;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. Conversation history
// ─────────────────────────────────────────────────────────────────────────────

export const conversationStore = {
  dir(): string {
    return path.join(opOneRoot(), 'conversations');
  },

  filePath(id: string): string {
    return path.join(this.dir(), `${id}.json`);
  },

  create(title?: string): Conversation {
    const now = new Date().toISOString();
    const conv: Conversation = {
      id: newId('conv'),
      title: title ?? 'Untitled',
      createdAt: now,
      updatedAt: now,
      turns: [],
    };
    writeJson(this.filePath(conv.id), conv);
    return conv;
  },

  get(id: string): Conversation | undefined {
    return readJson<Conversation | undefined>(this.filePath(id), undefined);
  },

  save(conv: Conversation): void {
    writeJson(this.filePath(conv.id), { ...conv, updatedAt: new Date().toISOString() });
  },

  /** Appends a turn, redacting before it touches disk. */
  append(id: string, turn: ConversationTurn): Conversation {
    const conv = this.get(id) ?? this.create();
    const safe = { ...turn, content: redactSecrets(turn.content) };
    conv.turns.push(safe);
    // First user message names the conversation — from the redacted text, so a
    // secret pasted into the opening message cannot survive as the title.
    if (conv.title === 'Untitled' && safe.role === 'user') {
      conv.title = safe.content.slice(0, 60).replace(/\n/g, ' ') || 'Untitled';
    }
    conv.updatedAt = new Date().toISOString();
    writeJson(this.filePath(conv.id), conv);
    return conv;
  },

  list(): Conversation[] {
    const dir = this.dir();
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => readJson<Conversation | null>(path.join(dir, f), null))
      .filter((c): c is Conversation => c !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  },

  delete(id: string): boolean {
    const p = this.filePath(id);
    if (!fs.existsSync(p)) return false;
    fs.unlinkSync(p);
    return true;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. Personal preferences
// ─────────────────────────────────────────────────────────────────────────────

export const preferencesStore = {
  filePath(): string {
    return path.join(opOneRoot(), 'preferences.json');
  },

  load(): Preferences {
    const raw = readJson<Partial<Preferences>>(this.filePath(), {});
    // Merged against defaults so an older file missing `mesh` still loads with
    // mesh disabled rather than crashing or defaulting to enabled.
    return {
      ...DEFAULT_PREFERENCES,
      ...raw,
      mesh: { ...DEFAULT_PREFERENCES.mesh, ...(raw.mesh ?? {}) },
      notes: raw.notes ?? [],
    };
  },

  save(prefs: Preferences): Preferences {
    const next = { ...prefs, updatedAt: new Date().toISOString() };
    writeJson(this.filePath(), next);
    return next;
  },

  update(patch: Partial<Preferences>): Preferences {
    return this.save({ ...this.load(), ...patch });
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// 4. Verified reusable knowledge
// ─────────────────────────────────────────────────────────────────────────────

export interface KnowledgeItem {
  id: string;
  text: string;
  provenance: Provenance;
}

export const knowledgeStore = {
  dir(): string {
    return path.join(opOneRoot(), 'knowledge');
  },

  filePath(id: string): string {
    return path.join(this.dir(), `${id}.json`);
  },

  /**
   * Writes a reusable knowledge item.
   *
   * Refuses anything whose provenance is not `verified`: this store is the one
   * place the client treats as trustworthy, and letting unverified content in
   * would quietly defeat the ranking rule in ./memory.ts.
   */
  save(item: Omit<KnowledgeItem, 'id'> & { id?: string }): KnowledgeItem {
    if (item.provenance.verification !== 'verified') {
      throw new Error(
        `knowledge store accepts verified items only (got "${item.provenance.verification}")`,
      );
    }
    const full: KnowledgeItem = {
      id: item.id ?? newId('know'),
      text: redactSecrets(item.text),
      provenance: item.provenance,
    };
    writeJson(this.filePath(full.id), full);
    return full;
  },

  list(): KnowledgeItem[] {
    const dir = this.dir();
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => readJson<KnowledgeItem | null>(path.join(dir, f), null))
      .filter((k): k is KnowledgeItem => k !== null);
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// 3. Engineering episodes (OP One provenance envelope)
// ─────────────────────────────────────────────────────────────────────────────

export const opOneEpisodeStore = {
  dir(): string {
    return path.join(opOneRoot(), 'episodes');
  },

  filePath(id: string): string {
    return path.join(this.dir(), `${id}.json`);
  },

  /** Persists an episode, deep-redacting evidence before it reaches disk. */
  save(episode: OpOneEpisode): OpOneEpisode {
    const safe: OpOneEpisode = {
      ...episode,
      request: redactSecrets(episode.request),
      summary: redactSecrets(episode.summary),
      verification: redactValue(episode.verification),
    };
    writeJson(this.filePath(safe.id), safe);
    return safe;
  },

  get(id: string): OpOneEpisode | undefined {
    return readJson<OpOneEpisode | undefined>(this.filePath(id), undefined);
  },

  list(): OpOneEpisode[] {
    const dir = this.dir();
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => readJson<OpOneEpisode | null>(path.join(dir, f), null))
      .filter((e): e is OpOneEpisode => e !== null)
      .sort((a, b) => b.at.localeCompare(a.at));
  },
};

export { newId };
