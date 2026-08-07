// ─────────────────────────────────────────────────────────────────────────────
// Aura OP One — Agent Mesh boundary
// ─────────────────────────────────────────────────────────────────────────────
//
// Agent Mesh is an OPTIONAL delegated-execution layer, DISABLED BY DEFAULT.
//
// It is responsible for one thing: executing a delegated sub-task and returning
// structured results. It is not responsible for — and structurally cannot reach —
// user intent, experience retrieval, permissions, verification, final synthesis,
// or episode recording. Those stay in Aura OP One (architecture §4).
//
// Two invariants are enforced here rather than documented and hoped for:
//
//   1. A mesh result arrives `unverified`. There is no code path from a mesh
//      response to a `verified` state that does not go through the same gate as
//      local work.
//   2. Every action a mesh agent asks for is permission-checked through the same
//      `Engine.checkPermission`. A transport that returns "already approved" is
//      ignored; approval is not something the remote side gets to assert.

import type { Engine } from './engine.js';
import type { Preferences, MeshRoutingRule } from './types.js';

export interface MeshTask {
  /** The delegated sub-task. */
  task: string;
  projectRoot: string;
  /** Tools the mesh agent may request. Subset of the local agent's grant. */
  permittedTools: string[];
}

/** What a mesh transport returns. Results, not authority. */
export interface MeshResult {
  success: boolean;
  summary: string;
  /** Actions the mesh agent performed or wants performed, as evidence. */
  toolCalls: Array<{ name: string; input: Record<string, unknown> }>;
  error?: string;
}

/** Pluggable transport, so the boundary can be tested without a live mesh. */
export interface MeshTransport {
  /** Human-readable transport name, shown by `:mesh`. */
  readonly name: string;
  available(): Promise<boolean>;
  execute(task: MeshTask): Promise<MeshResult>;
}

export interface MeshDecision {
  /** Whether the mesh should handle this request. */
  useMesh: boolean;
  /** Why — always visible, never invisible routing. */
  reason: string;
  /** The rule that matched, when one did. */
  rule?: MeshRoutingRule;
}

/**
 * Decides whether a request goes to the mesh.
 *
 * Mesh runs only on an explicit user request or a visible, configurable rule —
 * and never at all while `prefs.mesh.enabled` is false, which is the default.
 */
export function decideMesh(
  request: string,
  prefs: Preferences,
  explicitlyRequested: boolean,
): MeshDecision {
  if (!prefs.mesh.enabled) {
    return {
      useMesh: false,
      reason: explicitlyRequested
        ? 'Agent Mesh is disabled (:mesh on to enable)'
        : 'Agent Mesh is disabled by default',
    };
  }
  if (explicitlyRequested) {
    return { useMesh: true, reason: 'explicitly requested by the user' };
  }

  for (const rule of prefs.mesh.rules) {
    if (matchesRule(request, rule)) {
      return { useMesh: true, reason: `routing rule matched: ${rule.reason}`, rule };
    }
  }

  return { useMesh: false, reason: 'no routing rule matched' };
}

/** `/pattern/flags` is treated as a regex; anything else as a substring. */
export function matchesRule(request: string, rule: MeshRoutingRule): boolean {
  const m = /^\/(.*)\/([gimsuy]*)$/.exec(rule.match);
  if (m) {
    try {
      return new RegExp(m[1], m[2]).test(request);
    } catch {
      return false;
    }
  }
  return request.toLowerCase().includes(rule.match.toLowerCase());
}

export interface MeshRunOutcome {
  /** True when the mesh actually executed the task. */
  ranOnMesh: boolean;
  result: MeshResult;
  /** Set when the mesh was unavailable or failed and local execution took over. */
  fallback?: { from: string; to: string; reason: string };
  /** Actions the permission system refused. Reported, never routed around. */
  deniedActions: Array<{ tool: string; reason: string }>;
}

/**
 * Runs a delegated task on the mesh, falling back to local execution.
 *
 * The permission sweep happens *after* the transport returns and *before* the
 * result is accepted: a mesh agent's reported actions are treated as claims to
 * be checked, not as a record of things that were legitimately allowed.
 */
export async function runOnMesh(
  engine: Engine,
  transport: MeshTransport,
  task: MeshTask,
): Promise<MeshRunOutcome> {
  const localFallback = async (reason: string): Promise<MeshRunOutcome> => {
    const local = await engine.run({
      projectRoot: task.projectRoot,
      task: task.task,
      model: 'fallback',
      allowedTools: task.permittedTools,
    });
    return {
      ranOnMesh: false,
      result: {
        success: local.success,
        summary: local.summary,
        toolCalls: local.toolCalls,
        error: local.error,
      },
      fallback: { from: `mesh:${transport.name}`, to: 'local-agent', reason },
      deniedActions: [],
    };
  };

  let available = false;
  try {
    available = await transport.available();
  } catch (e) {
    return localFallback(`mesh availability check failed: ${errText(e)}`);
  }
  if (!available) return localFallback('mesh transport unavailable');

  let result: MeshResult;
  try {
    result = await transport.execute(task);
  } catch (e) {
    return localFallback(`mesh execution failed: ${errText(e)}`);
  }

  if (!result.success) {
    return localFallback(`mesh returned failure: ${result.error ?? 'unknown error'}`);
  }

  // Every action the mesh reports is checked locally. A mesh agent cannot
  // bypass permissions by claiming an action was already approved remotely.
  const deniedActions: Array<{ tool: string; reason: string }> = [];
  const allowedCalls: MeshResult['toolCalls'] = [];

  for (const call of result.toolCalls) {
    if (!task.permittedTools.includes(call.name)) {
      deniedActions.push({ tool: call.name, reason: 'tool not in the delegated grant' });
      continue;
    }
    const outcome = engine.checkPermission(call.name, call.input);
    if (!outcome.allowed) {
      deniedActions.push({ tool: call.name, reason: outcome.reason ?? 'permission denied' });
      continue;
    }
    allowedCalls.push(call);
  }

  return {
    ranOnMesh: true,
    // Only permitted calls survive as evidence — a denied action must not be
    // able to satisfy the verification gate.
    result: { ...result, toolCalls: allowedCalls },
    deniedActions,
  };
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * A transport that is never available.
 *
 * This is the default, and it is what makes "disabled by default" true of the
 * code and not just of the config: with no transport configured, the mesh path
 * always falls back to local execution.
 */
export function createNullTransport(): MeshTransport {
  return {
    name: 'none',
    async available() {
      return false;
    },
    async execute(): Promise<MeshResult> {
      return { success: false, summary: '', toolCalls: [], error: 'no mesh transport configured' };
    },
  };
}
