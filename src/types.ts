// ─────────────────────────────────────────────────────────────────────────────
// Aura OP One — core domain types
// ─────────────────────────────────────────────────────────────────────────────
//
// These types describe what Aura OP One owns: agents, memory records with
// provenance, verification lifecycle, and episode provenance. Execution,
// verification checks, permissions and model resolution belong to aura-code and
// are reached only through the `Engine` seam (see ./engine.ts).

/** Package/application id. */
export const APP_ID = 'aura-op-one';
export const PRODUCT_NAME = 'Aura OP One';

// ─────────────────────────────────────────────────────────────────────────────
// Verification lifecycle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Explicit verification states. There is no implicit sixth state: output that
 * has not been through the gate is `unverified`, never optimistically "verified".
 */
export type VerificationState =
  | 'unverified'
  | 'verification_pending'
  | 'verified'
  | 'rejected'
  | 'escalated';

export const VERIFICATION_STATES: readonly VerificationState[] = [
  'unverified',
  'verification_pending',
  'verified',
  'rejected',
  'escalated',
] as const;

/**
 * Evidence the verifier actually examined, kept structured so an episode can be
 * audited later without re-parsing prose.
 */
export interface VerificationEvidence {
  /** Tool calls the agent made during execution. */
  toolCalls: Array<{ name: string; input: Record<string, unknown> }>;
  /** Files reported as changed. */
  filesChanged: string[];
  /** Test commands actually executed. */
  testsExecuted: string[];
  /** Commit SHA, when the change was committed. */
  commitSha?: string;
}

/** The verifier's decision plus the evidence behind it. */
export interface VerificationRecord {
  state: VerificationState;
  /** Human-readable verifier decision. */
  decision: string;
  /** Individual gate checks, as returned by aura-code's verification gate. */
  checks: Array<{ name: string; passed: boolean; detail: string }>;
  evidence: VerificationEvidence;
  /** ISO-8601. */
  at: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Provenance
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Attached to every retrievable memory record and never dropped on retrieval.
 * Retrieval ranking depends on `verification` and `confidence`.
 */
export interface Provenance {
  /** Where this came from, e.g. "conversation", "episode:abc123", "council". */
  source: string;
  /** ISO-8601 creation time. */
  createdAt: string;
  /** 0..1. */
  confidence: number;
  verification: VerificationState;
  /** Agent that produced it, when applicable. */
  agentId?: string;
  /** Project it relates to, when applicable. */
  projectRoot?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Agents
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How an agent picks a model. Resolution defers to aura-code's Archimedes
 * alternator and competence tracking — see Engine.resolveModel.
 */
export type ModelPolicy =
  /** Try the local model when competence allows; escalate to cloud otherwise. */
  | { kind: 'local-first' }
  /** Always the configured cloud model. */
  | { kind: 'cloud-only' }
  /** Local model only; fails closed rather than silently spending cloud tokens. */
  | { kind: 'local-only' }
  /** A pinned model id. */
  | { kind: 'pinned'; model: string };

/** When an agent's output goes through the verification gate. */
export type VerificationPolicy =
  /** Everything is verified. */
  | 'always'
  /** Verified when the output touched files, shell, or git. */
  | 'on-code-change'
  /** Only on explicit `:verify`. */
  | 'manual';

/** Which memory categories an agent may read. */
export type MemoryScope =
  /** Conversation + preferences + verified knowledge + episodes. */
  | 'full'
  /** Verified knowledge + episodes only — no personal content. */
  | 'engineering'
  /** Nothing persistent; the current turn only. */
  | 'none';

/**
 * A manually created agent. MVP has no automatic generation — see the
 * architecture document, §13.
 */
export interface AgentDefinition {
  /** Stable id, immutable once created. */
  id: string;
  name: string;
  /** One line: what this agent is for. */
  purpose: string;
  /** The instruction handed to the engine as a system prompt. */
  instruction: string;
  /** Tool names this agent may use. Enforced by aura-code's loop + permissions. */
  permittedTools: string[];
  modelPolicy: ModelPolicy;
  verificationPolicy: VerificationPolicy;
  memoryScope: MemoryScope;
  /** ISO-8601. */
  createdAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Memory records
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The six categories are stored separately (see architecture §7). This tag
 * identifies which store a retrieved record came from; it is not a schema for a
 * single merged store.
 */
export type MemoryCategory =
  | 'conversation'
  | 'preference'
  | 'episode'
  | 'knowledge'
  | 'agent'
  | 'scratch';

/** A single retrievable item, always carrying its provenance. */
export interface MemoryRecord {
  id: string;
  category: MemoryCategory;
  /** The retrievable text. */
  text: string;
  provenance: Provenance;
}

/** A retrieval hit: the record plus why it ranked where it did. */
export interface RetrievalHit {
  record: MemoryRecord;
  /** Final ranking score. Higher is better. */
  score: number;
  /** Human-readable ranking explanation, shown by `:memory`. */
  reason: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Conversation
// ─────────────────────────────────────────────────────────────────────────────

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
  at: string;
  /** Agent that produced an assistant turn. */
  agentId?: string;
  /** Model that produced an assistant turn. */
  model?: string;
  /** Verification state of an assistant turn, when it was gated. */
  verification?: VerificationState;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turns: ConversationTurn[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Preferences
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A visible, configurable rule that may route a request to the Agent Mesh
 * without the user asking each time. Mesh stays off unless `mesh.enabled`.
 */
export interface MeshRoutingRule {
  /** Case-insensitive substring or /regex/ matched against the request. */
  match: string;
  /** Why this rule exists — shown by `:mesh` so routing is never invisible. */
  reason: string;
}

export interface Preferences {
  /** Default agent id for new conversations. */
  defaultAgentId?: string;
  /** Session model override; empty means the agent's policy decides. */
  preferredModel?: string;
  mesh: {
    /** Agent Mesh is disabled by default. */
    enabled: boolean;
    endpoint?: string;
    /** Visible routing rules. Only consulted when `enabled` is true. */
    rules: MeshRoutingRule[];
  };
  /** Free-form personal notes — explicitly NOT engineering knowledge. */
  notes: string[];
  updatedAt: string;
}

export const DEFAULT_PREFERENCES: Preferences = {
  mesh: { enabled: false, rules: [] },
  notes: [],
  updatedAt: new Date(0).toISOString(),
};

// ─────────────────────────────────────────────────────────────────────────────
// Episodes (OP One provenance envelope)
// ─────────────────────────────────────────────────────────────────────────────

/** How the work was actually executed. */
export type ExecutionMode = 'local-agent' | 'council' | 'mesh';

/**
 * OP One's record of one pass through the canonical loop. This is the provenance
 * envelope described in architecture §14.5 — aura-code's own `Episode` stays
 * Archimedes-shaped and is written alongside it.
 */
export interface OpOneEpisode {
  id: string;
  at: string;
  projectRoot: string;
  request: string;
  agentId: string;
  /** The model that actually ran, not the one that was requested. */
  model: string;
  /** True when the model that ran was the local (Archimedes) model. */
  usedLocalModel: boolean;
  mode: ExecutionMode;
  /** Ids of memory records retrieved for this request. */
  retrievedMemoryIds: string[];
  summary: string;
  verification: VerificationRecord;
  /** Set when the user was asked to approve a commit. */
  commitApproved?: boolean;
  /** Populated when a fallback fired, e.g. local model down, mesh unreachable. */
  fallback?: { from: string; to: string; reason: string };
  durationMs: number;
  tokens: { input: number; output: number };
}
