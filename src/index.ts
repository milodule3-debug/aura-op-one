// ─────────────────────────────────────────────────────────────────────────────
// Aura OP One — public surface
// ─────────────────────────────────────────────────────────────────────────────
//
// The minimal personal and agentic client for the Aura ecosystem.
// See AURA_OP_ONE_ARCHITECTURE.md for what this owns and what stays in aura-code.

export { APP_ID, PRODUCT_NAME, VERIFICATION_STATES, DEFAULT_PREFERENCES } from './types.js';
export type {
  VerificationState,
  VerificationRecord,
  VerificationEvidence,
  Provenance,
  AgentDefinition,
  ModelPolicy,
  VerificationPolicy,
  MemoryScope,
  MemoryCategory,
  MemoryRecord,
  RetrievalHit,
  Conversation,
  ConversationTurn,
  Preferences,
  MeshRoutingRule,
  OpOneEpisode,
  ExecutionMode,
} from './types.js';

// The aura-code boundary — the only seam.
export { createAuraCodeEngine, extractEvidence } from './engine.js';
export type {
  Engine,
  EngineRunRequest,
  EngineRunResult,
  EngineVerifyRequest,
  EngineVerifyResult,
  EngineCouncilRequest,
  EngineCouncilResult,
  EngineEpisodeInput,
  PermissionOutcome,
  ResolvedModel,
  ResolveModelRequest,
} from './engine.js';

export { OpOneSession } from './session.js';
export type { SessionOptions, TurnResult, TurnTimings } from './session.js';

export {
  validateAgent,
  isValidAgent,
  defaultAgent,
  AgentSchemaError,
  KNOWN_TOOLS,
} from './agent-schema.js';

export {
  agentStore,
  conversationStore,
  preferencesStore,
  knowledgeStore,
  opOneEpisodeStore,
  opOneRoot,
} from './stores.js';
export type { KnowledgeItem } from './stores.js';

export {
  retrieve,
  rank,
  collectCandidates,
  matchScore,
  tierFor,
  formatForPrompt,
  promoteToKnowledge,
} from './memory.js';

export {
  runVerification,
  transition,
  canTransition,
  stateLabel,
  unverifiedRecord,
  mayCommit,
  LEGAL_TRANSITIONS,
  IllegalTransitionError,
} from './verification.js';

export { runCouncil, compareSeats, councilProvenance, CouncilError, MAX_SEATS } from './council.js';
export type { CouncilRequest, CouncilOutcome } from './council.js';

export { decideMesh, runOnMesh, matchesRule, createNullTransport } from './mesh.js';
export type { MeshTransport, MeshTask, MeshResult, MeshDecision, MeshRunOutcome } from './mesh.js';

export { runCommand, isCommand, formatTurn } from './commands.js';
export type { CommandResult } from './commands.js';

export { redactSecrets, redactValue } from './redact.js';
export { renderStatusLine, renderAssistant, createSilentDisplay, HELP_TEXT } from './display.js';
export type { StatusLine } from './display.js';
