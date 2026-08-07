// ─────────────────────────────────────────────────────────────────────────────
// Aura OP One — the canonical loop
// ─────────────────────────────────────────────────────────────────────────────
//
//   Request → retrieve experience → select agent/model → act → verify
//           → record episode → improve future routing
//
// Each step is a named private method below so the loop reads the way the
// architecture document describes it. Nothing here executes, verifies or
// permission-checks on its own — all of that crosses the `Engine` seam.

import type {
  AgentDefinition,
  OpOneEpisode,
  Preferences,
  VerificationRecord,
  ExecutionMode,
  Provenance,
} from './types.js';
import type { Engine } from './engine.js';
import type { MeshTransport } from './mesh.js';
import { defaultAgent } from './agent-schema.js';
import {
  agentStore,
  conversationStore,
  preferencesStore,
  opOneEpisodeStore,
  newId,
} from './stores.js';
import { retrieve, formatForPrompt, promoteToKnowledge } from './memory.js';
import { runVerification, unverifiedRecord, mayCommit } from './verification.js';
import { decideMesh, runOnMesh, createNullTransport } from './mesh.js';
import { redactSecrets } from './redact.js';

export interface SessionOptions {
  engine: Engine;
  projectRoot: string;
  /** Existing conversation to resume; a new one is created otherwise. */
  conversationId?: string;
  /** Mesh transport. Defaults to the null transport (never available). */
  meshTransport?: MeshTransport;
  /** Test command handed to the verification gate. */
  testCommand?: string;
  /**
   * Asks the user to approve a consequential action. Defaults to refusing —
   * the client must never assume approval it did not get.
   */
  confirm?: (message: string) => Promise<boolean>;
}

/** Timings for one turn, so performance can be reported rather than claimed. */
export interface TurnTimings {
  retrievalMs: number;
  modelSelectionMs: number;
  executionMs: number;
  verificationMs: number;
  recordingMs: number;
  totalMs: number;
}

export interface TurnResult {
  reply: string;
  agent: AgentDefinition;
  model: string;
  usedLocalModel: boolean;
  mode: ExecutionMode;
  verification: VerificationRecord;
  episode: OpOneEpisode;
  /** Memory hits used for this turn, provenance intact. */
  retrieved: ReturnType<typeof retrieve>;
  timings: TurnTimings;
  /** Populated when a fallback fired (local model down, mesh unavailable). */
  fallback?: { from: string; to: string; reason: string };
  /** Actions the permission system refused during delegated execution. */
  deniedActions: Array<{ tool: string; reason: string }>;
}

/**
 * One conversation with Aura OP One. Holds the active agent, the active model
 * override, and the conversation id — the three things the default screen shows.
 */
export class OpOneSession {
  readonly engine: Engine;
  readonly projectRoot: string;
  conversationId: string;

  private agent: AgentDefinition;
  private modelOverride?: string;
  private prefs: Preferences;
  private readonly meshTransport: MeshTransport;
  private readonly testCommand?: string;
  private readonly confirm: (message: string) => Promise<boolean>;

  /** The last turn, for `:verify` and the commit gate. */
  private lastTurn?: TurnResult;

  constructor(opts: SessionOptions) {
    this.engine = opts.engine;
    this.projectRoot = opts.projectRoot;
    this.meshTransport = opts.meshTransport ?? createNullTransport();
    this.testCommand = opts.testCommand;
    // Defaults to refusing: silence is not consent for a consequential action.
    this.confirm = opts.confirm ?? (async () => false);

    this.prefs = preferencesStore.load();
    this.conversationId = opts.conversationId ?? conversationStore.create().id;

    const preferred = this.prefs.defaultAgentId
      ? agentStore.get(this.prefs.defaultAgentId)
      : undefined;
    this.agent = preferred ?? agentStore.list()[0] ?? defaultAgent();
    this.modelOverride = this.prefs.preferredModel;
  }

  // ── accessors used by the command layer and the status line ──────────────

  activeAgent(): AgentDefinition { return this.agent; }
  activeModelOverride(): string | undefined { return this.modelOverride; }
  preferences(): Preferences { return this.prefs; }
  meshEnabled(): boolean { return this.prefs.mesh.enabled; }
  lastResult(): TurnResult | undefined { return this.lastTurn; }

  setAgent(agent: AgentDefinition): void { this.agent = agent; }

  setModelOverride(model: string | undefined): void {
    this.modelOverride = model;
    this.prefs = preferencesStore.update({ preferredModel: model });
  }

  setMeshEnabled(enabled: boolean): void {
    this.prefs = preferencesStore.update({ mesh: { ...this.prefs.mesh, enabled } });
  }

  reloadPreferences(): void { this.prefs = preferencesStore.load(); }

  // ── the canonical loop ────────────────────────────────────────────────────

  /**
   * Runs one full turn.
   *
   * @param request      the user's message
   * @param opts.mesh    explicit `:mesh run` — asks for delegated execution
   */
  async handle(request: string, opts: { mesh?: boolean } = {}): Promise<TurnResult> {
    const t0 = Date.now();

    // 1. Request
    conversationStore.append(this.conversationId, {
      role: 'user',
      content: request,
      at: new Date().toISOString(),
    });

    // 2. Retrieve experience
    const tRetrieve = Date.now();
    const retrieved = this.retrieveExperience(request);
    const retrievalMs = Date.now() - tRetrieve;

    // 3. Select agent and model
    const tSelect = Date.now();
    const resolved = await this.engine.resolveModel({
      policy: this.agent.modelPolicy,
      task: request,
      projectRoot: this.projectRoot,
      override: this.modelOverride,
    });
    const modelSelectionMs = Date.now() - tSelect;
    let fallback = resolved.fallback;

    // 4. Act
    const tExec = Date.now();
    const filesBefore = this.engine.snapshotFiles(this.projectRoot);
    const execution = await this.act(request, retrieved, resolved.model, opts.mesh ?? false);
    const executionMs = Date.now() - tExec;
    if (execution.fallback) fallback = execution.fallback;

    // 5. Verify
    const tVerify = Date.now();
    const verification = await this.verifyIfNeeded(
      request,
      execution,
      tExec,
      filesBefore,
    );
    const verificationMs = Date.now() - tVerify;

    // 6. Record episode
    const tRecord = Date.now();
    const episode = await this.recordEpisode({
      request,
      retrieved,
      resolved,
      execution,
      verification,
      fallback,
      durationMs: Date.now() - t0,
    });
    const recordingMs = Date.now() - tRecord;

    // 7. Improve future routing
    this.improveRouting(request, execution.summary, verification, episode);

    const reply = redactSecrets(execution.summary || '(no output)');
    conversationStore.append(this.conversationId, {
      role: 'assistant',
      content: reply,
      at: new Date().toISOString(),
      agentId: this.agent.id,
      model: resolved.model,
      verification: verification.state,
    });

    const result: TurnResult = {
      reply,
      agent: this.agent,
      model: resolved.model,
      usedLocalModel: resolved.isLocal,
      mode: execution.mode,
      verification,
      episode,
      retrieved,
      fallback,
      deniedActions: execution.deniedActions,
      timings: {
        retrievalMs,
        modelSelectionMs,
        executionMs,
        verificationMs,
        recordingMs,
        totalMs: Date.now() - t0,
      },
    };

    this.lastTurn = result;
    return result;
  }

  // ── step 2 ────────────────────────────────────────────────────────────────

  private retrieveExperience(request: string) {
    return retrieve({
      query: request,
      scope: this.agent.memoryScope,
      projectRoot: this.projectRoot,
      conversationId: this.conversationId,
      limit: 8,
    });
  }

  // ── step 4 ────────────────────────────────────────────────────────────────

  private async act(
    request: string,
    retrieved: ReturnType<typeof retrieve>,
    model: string,
    explicitMesh: boolean,
  ): Promise<{
    summary: string;
    success: boolean;
    toolCalls: Array<{ name: string; input: Record<string, unknown> }>;
    tokens: { input: number; output: number };
    mode: ExecutionMode;
    fallback?: { from: string; to: string; reason: string };
    deniedActions: Array<{ tool: string; reason: string }>;
  }> {
    const experience = formatForPrompt(retrieved);
    const task = experience ? `${experience}\n\n---\n\nRequest: ${request}` : request;

    const meshDecision = decideMesh(request, this.prefs, explicitMesh);

    if (meshDecision.useMesh) {
      const outcome = await runOnMesh(this.engine, this.meshTransport, {
        task,
        projectRoot: this.projectRoot,
        permittedTools: this.agent.permittedTools,
      });
      return {
        summary: outcome.result.summary,
        success: outcome.result.success,
        toolCalls: outcome.result.toolCalls,
        tokens: { input: 0, output: 0 },
        mode: outcome.ranOnMesh ? 'mesh' : 'local-agent',
        fallback: outcome.fallback,
        deniedActions: outcome.deniedActions,
      };
    }

    const run = await this.engine.run({
      projectRoot: this.projectRoot,
      task,
      model,
      instruction: this.agent.instruction,
      allowedTools: this.agent.permittedTools,
    });

    return {
      summary: run.summary,
      success: run.success,
      toolCalls: run.toolCalls,
      tokens: run.tokens,
      mode: 'local-agent',
      deniedActions: [],
    };
  }

  // ── step 5 ────────────────────────────────────────────────────────────────

  /**
   * Applies the agent's verification policy.
   *
   * Output that is not gated stays `unverified` — the default state exists so
   * that "we didn't check" is representable and visible, rather than collapsing
   * into an implicit pass.
   */
  private async verifyIfNeeded(
    request: string,
    execution: { toolCalls: Array<{ name: string; input: Record<string, unknown> }> },
    taskStartedAt: number,
    filesBefore: Set<string>,
  ): Promise<VerificationRecord> {
    const policy = this.agent.verificationPolicy;
    const touchedCode = execution.toolCalls.some(c =>
      ['write_file', 'edit_file', 'run_shell', 'git'].includes(c.name),
    );

    const shouldVerify = policy === 'always' || (policy === 'on-code-change' && touchedCode);
    if (!shouldVerify) return unverifiedRecord({ toolCalls: execution.toolCalls });

    return runVerification(this.engine, {
      projectRoot: this.projectRoot,
      task: request,
      taskStartedAt,
      toolCalls: execution.toolCalls,
      filesBefore,
      testCommand: this.testCommand,
    });
  }

  /** Explicit `:verify` on the last turn. */
  async verifyLast(): Promise<VerificationRecord | undefined> {
    const last = this.lastTurn;
    if (!last) return undefined;

    const record = await runVerification(this.engine, {
      projectRoot: this.projectRoot,
      task: last.episode.request,
      taskStartedAt: Date.parse(last.episode.at) - last.episode.durationMs,
      toolCalls: last.verification.evidence.toolCalls,
      filesBefore: new Set<string>(),
      testCommand: this.testCommand,
    });

    last.verification = record;
    opOneEpisodeStore.save({ ...last.episode, verification: record });
    return record;
  }

  // ── step 6 ────────────────────────────────────────────────────────────────

  private async recordEpisode(args: {
    request: string;
    retrieved: ReturnType<typeof retrieve>;
    resolved: { model: string; isLocal: boolean };
    execution: {
      summary: string;
      mode: ExecutionMode;
      tokens: { input: number; output: number };
    };
    verification: VerificationRecord;
    fallback?: { from: string; to: string; reason: string };
    durationMs: number;
  }): Promise<OpOneEpisode> {
    const episode: OpOneEpisode = {
      id: newId('ep'),
      at: new Date().toISOString(),
      projectRoot: this.projectRoot,
      request: args.request,
      agentId: this.agent.id,
      model: args.resolved.model,
      usedLocalModel: args.resolved.isLocal,
      mode: args.execution.mode,
      retrievedMemoryIds: args.retrieved.map(h => h.record.id),
      summary: args.execution.summary,
      verification: args.verification,
      fallback: args.fallback,
      durationMs: args.durationMs,
      tokens: args.execution.tokens,
    };

    const saved = opOneEpisodeStore.save(episode);

    // Mirrored into aura-code's own episode store so competence and routing
    // learn from this turn too. A store failure must not lose the turn.
    try {
      await this.engine.recordEpisode(this.projectRoot, {
        id: saved.id,
        task: args.request,
        usedLocalModel: args.resolved.isLocal,
        largeModelUsed: args.resolved.isLocal ? undefined : args.resolved.model,
        verifierApproved: args.verification.state === 'verified',
        tokens: args.resolved.isLocal
          ? { local: args.execution.tokens.input + args.execution.tokens.output }
          : { large: args.execution.tokens.input + args.execution.tokens.output },
        durationMs: args.durationMs,
      });
    } catch {
      // Surfaced by :status via the episode's own record; not fatal to the turn.
    }

    return saved;
  }

  // ── step 7 ────────────────────────────────────────────────────────────────

  /**
   * Promotes verified outcomes into reusable knowledge.
   *
   * Only `verified` turns are promoted, which is what keeps the knowledge tier
   * meaningful for the next request's retrieval ranking.
   */
  private improveRouting(
    request: string,
    summary: string,
    verification: VerificationRecord,
    episode: OpOneEpisode,
  ): void {
    if (verification.state !== 'verified') return;

    const provenance: Provenance = {
      source: `episode:${episode.id}`,
      createdAt: episode.at,
      confidence: 0.9,
      verification: 'verified',
      agentId: this.agent.id,
      projectRoot: this.projectRoot,
    };

    promoteToKnowledge(`${request}\n\n${summary}`, provenance);
  }

  // ── commits ───────────────────────────────────────────────────────────────

  /**
   * Commits the last turn's work.
   *
   * Two independent gates: the change must be `verified`, and the user must
   * approve. Verification is not permission (architecture §8) — passing the gate
   * does not grant the commit, and there is no auto-commit path.
   */
  async commitLast(message: string): Promise<{ committed: boolean; reason: string; sha?: string }> {
    const last = this.lastTurn;
    if (!last) return { committed: false, reason: 'nothing to commit' };

    const files = last.verification.evidence.filesChanged;
    if (files.length === 0) return { committed: false, reason: 'no files changed' };

    const approved = await this.confirm(
      `Commit ${files.length} file(s)?\n  ${files.join('\n  ')}\n  message: ${message}`,
    );

    const gate = mayCommit(last.verification, approved);
    if (!gate.allowed) return { committed: false, reason: gate.reason };

    const perm = this.engine.checkPermission('git', { action: 'commit', message });
    if (!perm.allowed) {
      return { committed: false, reason: perm.reason ?? 'git commit denied by permissions' };
    }

    const run = await this.engine.run({
      projectRoot: this.projectRoot,
      task: `Commit the current staged and unstaged changes with the message: ${message}`,
      model: last.model,
      allowedTools: ['git', 'run_shell'],
      maxTurns: 4,
    });
    if (!run.success) return { committed: false, reason: run.error ?? 'commit failed' };

    const sha = extractSha(run.summary);
    // The commit SHA belongs in the audit trail, so the episode is rewritten
    // with the completed evidence rather than left describing an uncommitted change.
    last.verification.evidence.commitSha = sha;
    opOneEpisodeStore.save({
      ...last.episode,
      verification: last.verification,
      commitApproved: true,
    });

    return { committed: true, reason: 'committed', sha };
  }
}

function extractSha(text: string): string | undefined {
  const m = /\b([0-9a-f]{7,40})\b/.exec(text);
  return m?.[1];
}
