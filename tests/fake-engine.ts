// Test double for the aura-code boundary.
//
// Everything in src/op-one/ depends on the `Engine` interface, so the whole
// client is exercisable without providers, tools, a terminal, or a network.
// That this file is possible at all is the evidence that the boundary holds.

import type {
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
} from '../src/engine.js';
import { extractEvidence } from '../src/engine.js';

export interface FakeEngineOptions {
  /** Canned run result, or a function of the request. */
  run?: Partial<EngineRunResult> | ((req: EngineRunRequest) => Partial<EngineRunResult>);
  /** Whether the verification gate passes. */
  verifyPasses?: boolean;
  /** Make the gate throw, to exercise the escalated path. */
  verifyThrows?: boolean;
  /** Tools the permission system denies. */
  deniedTools?: string[];
  /** Local model availability, for local-first / local-only policies. */
  localAvailable?: boolean;
  /** Seat answers keyed by role. */
  councilAnswers?: Record<string, string>;
  /** Roles whose seat fails to answer. */
  councilFailures?: string[];
  /** Files present before execution. */
  filesBefore?: string[];
}

export interface FakeEngine extends Engine {
  /** Every run request seen, in order. */
  readonly runs: EngineRunRequest[];
  /** Every episode handed to aura-code's store. */
  readonly episodes: EngineEpisodeInput[];
  /** Every permission check performed. */
  readonly permissionChecks: Array<{ tool: string; input: Record<string, unknown> }>;
  /** Every verify request. */
  readonly verifies: EngineVerifyRequest[];
}

export function createFakeEngine(opts: FakeEngineOptions = {}): FakeEngine {
  const runs: EngineRunRequest[] = [];
  const episodes: EngineEpisodeInput[] = [];
  const permissionChecks: Array<{ tool: string; input: Record<string, unknown> }> = [];
  const verifies: EngineVerifyRequest[] = [];

  const engine: FakeEngine = {
    runs,
    episodes,
    permissionChecks,
    verifies,

    async run(req: EngineRunRequest): Promise<EngineRunResult> {
      runs.push(req);
      const base: EngineRunResult = {
        success: true,
        summary: `did: ${req.task.slice(0, 60)}`,
        turns: 1,
        toolCalls: [],
        tokens: { input: 100, output: 50 },
      };
      const override = typeof opts.run === 'function' ? opts.run(req) : opts.run;
      return { ...base, ...(override ?? {}) };
    },

    async verify(req: EngineVerifyRequest): Promise<EngineVerifyResult> {
      verifies.push(req);
      if (opts.verifyThrows) throw new Error('gate exploded');
      const passed = opts.verifyPasses ?? true;
      return {
        passed,
        checks: [{ name: 'fake check', passed, detail: passed ? 'ok' : 'did not pass' }],
        suggestion: passed ? '' : 'fake check failed',
        evidence: extractEvidence(req.toolCalls, req.testCommand),
      };
    },

    async recordEpisode(_projectRoot: string, episode: EngineEpisodeInput): Promise<void> {
      episodes.push(episode);
    },

    checkPermission(tool: string, input: Record<string, unknown>): PermissionOutcome {
      permissionChecks.push({ tool, input });
      if (opts.deniedTools?.includes(tool)) {
        return { allowed: false, reason: `${tool} denied by policy` };
      }
      return { allowed: true };
    },

    async resolveModel(req: ResolveModelRequest): Promise<ResolvedModel> {
      const localUp = opts.localAvailable ?? true;
      if (req.override) return { model: req.override, isLocal: false, reason: 'session override' };

      switch (req.policy.kind) {
        case 'pinned':
          return { model: req.policy.model, isLocal: false, reason: 'pinned' };
        case 'cloud-only':
          return { model: 'cloud-model', isLocal: false, reason: 'cloud-only' };
        case 'local-only':
          return { model: 'local-model', isLocal: true, reason: 'local-only' };
        case 'local-first':
          if (!localUp) {
            return {
              model: 'cloud-model',
              isLocal: false,
              reason: 'local model unreachable',
              fallback: { from: 'local-model', to: 'cloud-model', reason: 'local model unreachable' },
            };
          }
          return { model: 'local-model', isLocal: true, reason: 'competence ok' };
      }
    },

    async runCouncilSeats(req: EngineCouncilRequest): Promise<EngineCouncilResult> {
      const seats: Array<{ role: string; answer: string }> = [];
      let failures = 0;
      for (const role of req.roles) {
        if (opts.councilFailures?.includes(role)) {
          failures++;
          continue;
        }
        const answer = opts.councilAnswers?.[role] ?? `${role} says: proceed carefully.`;
        seats.push({ role, answer });
      }
      return { seats, failures };
    },

    snapshotFiles(): Set<string> {
      return new Set(opts.filesBefore ?? []);
    },
  };

  return engine;
}
