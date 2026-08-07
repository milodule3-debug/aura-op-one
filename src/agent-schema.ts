// ─────────────────────────────────────────────────────────────────────────────
// Aura OP One — agent definition schema
// ─────────────────────────────────────────────────────────────────────────────
//
// Agents are hand-written JSON (architecture §12: no automatic generation in the
// MVP), so the format has to be inspectable and the validation has to say
// exactly what is wrong with a file someone edited by hand. Hence a hand-rolled
// validator that accumulates every problem rather than a schema library that
// stops at the first.

import type {
  AgentDefinition,
  ModelPolicy,
  VerificationPolicy,
  MemoryScope,
} from './types.js';

export class AgentSchemaError extends Error {
  constructor(readonly issues: string[]) {
    super(`invalid agent definition:\n  - ${issues.join('\n  - ')}`);
    this.name = 'AgentSchemaError';
  }
}

const VERIFICATION_POLICIES: VerificationPolicy[] = ['always', 'on-code-change', 'manual'];
const MEMORY_SCOPES: MemoryScope[] = ['full', 'engineering', 'none'];

/**
 * Tools an agent may be granted. This is the client-side allow-list; aura-code's
 * permission system independently gates what any of them may actually do, so a
 * typo here narrows an agent, it never widens one.
 */
export const KNOWN_TOOLS = [
  'read_file', 'list_dir', 'edit_file', 'write_file', 'search_code',
  'run_shell', 'run_tests', 'git', 'web_fetch', 'web_search', 'memory',
] as const;

const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/**
 * Validates and normalises an agent definition.
 *
 * @throws {AgentSchemaError} listing every problem found, not just the first.
 */
export function validateAgent(input: unknown): AgentDefinition {
  const issues: string[] = [];

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AgentSchemaError(['expected an object']);
  }
  const a = input as Record<string, unknown>;

  // — stable id —
  const id = a.id;
  if (typeof id !== 'string' || !id.trim()) {
    issues.push('id: required, must be a non-empty string');
  } else if (!ID_RE.test(id)) {
    issues.push('id: must be 1-64 chars of [a-zA-Z0-9_-] and start alphanumeric');
  }

  // — name / purpose / instruction —
  for (const field of ['name', 'purpose', 'instruction'] as const) {
    const v = a[field];
    if (typeof v !== 'string' || !v.trim()) {
      issues.push(`${field}: required, must be a non-empty string`);
    }
  }

  // — permitted tools —
  const tools = a.permittedTools;
  if (!Array.isArray(tools)) {
    issues.push('permittedTools: required, must be an array of tool names');
  } else {
    for (const t of tools) {
      if (typeof t !== 'string') {
        issues.push(`permittedTools: entries must be strings (got ${typeof t})`);
      } else if (!(KNOWN_TOOLS as readonly string[]).includes(t)) {
        issues.push(`permittedTools: unknown tool "${t}" (known: ${KNOWN_TOOLS.join(', ')})`);
      }
    }
  }

  // — model policy —
  const policy = a.modelPolicy;
  if (!policy || typeof policy !== 'object') {
    issues.push('modelPolicy: required, e.g. { "kind": "local-first" }');
  } else {
    const kind = (policy as Record<string, unknown>).kind;
    if (kind === 'pinned') {
      const m = (policy as Record<string, unknown>).model;
      if (typeof m !== 'string' || !m.trim()) {
        issues.push('modelPolicy: kind "pinned" requires a non-empty "model"');
      }
    } else if (!['local-first', 'cloud-only', 'local-only'].includes(String(kind))) {
      issues.push(
        `modelPolicy.kind: must be one of local-first, cloud-only, local-only, pinned (got "${String(kind)}")`,
      );
    }
  }

  // — verification policy —
  const vp = a.verificationPolicy;
  if (!VERIFICATION_POLICIES.includes(vp as VerificationPolicy)) {
    issues.push(
      `verificationPolicy: must be one of ${VERIFICATION_POLICIES.join(', ')} (got "${String(vp)}")`,
    );
  }

  // — memory scope —
  const ms = a.memoryScope;
  if (!MEMORY_SCOPES.includes(ms as MemoryScope)) {
    issues.push(`memoryScope: must be one of ${MEMORY_SCOPES.join(', ')} (got "${String(ms)}")`);
  }

  // — createdAt —
  const createdAt = a.createdAt;
  if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt))) {
    issues.push('createdAt: required, must be an ISO-8601 timestamp');
  }

  if (issues.length > 0) throw new AgentSchemaError(issues);

  return {
    id: (id as string).trim(),
    name: (a.name as string).trim(),
    purpose: (a.purpose as string).trim(),
    instruction: (a.instruction as string).trim(),
    permittedTools: tools as string[],
    modelPolicy: policy as ModelPolicy,
    verificationPolicy: vp as VerificationPolicy,
    memoryScope: ms as MemoryScope,
    createdAt: createdAt as string,
  };
}

/** True when `input` is a valid agent definition. */
export function isValidAgent(input: unknown): input is AgentDefinition {
  try {
    validateAgent(input);
    return true;
  } catch {
    return false;
  }
}

/**
 * The agent used when the user has not created one. Read-mostly and
 * verify-on-code-change: safe defaults for a first run.
 */
export function defaultAgent(): AgentDefinition {
  return {
    id: 'default',
    name: 'Default',
    purpose: 'General engineering assistance.',
    instruction:
      'You are a careful engineering assistant. Read before you write, make the ' +
      'smallest change that solves the problem, and run the project\'s tests to ' +
      'check your work.',
    permittedTools: ['read_file', 'list_dir', 'search_code', 'edit_file', 'write_file', 'run_shell', 'run_tests'],
    modelPolicy: { kind: 'local-first' },
    verificationPolicy: 'on-code-change',
    memoryScope: 'full',
    createdAt: new Date(0).toISOString(),
  };
}
