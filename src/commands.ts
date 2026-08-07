// ─────────────────────────────────────────────────────────────────────────────
// Aura OP One — commands
// ─────────────────────────────────────────────────────────────────────────────
//
// The `:` commands. Kept as a pure function of (session, input) → text so the
// command surface is testable without a terminal, and so the CLI stays a thin
// read-eval-print shell over it.
//
// Deliberately absent: anything that would expose graphs, dashboards, telemetry,
// internal routing tables, or configuration beyond what a person needs to steer
// the current turn.

import type { OpOneSession } from './session.js';
import type { AgentDefinition } from './types.js';
import { agentStore, preferencesStore, opOneEpisodeStore } from './stores.js';
import { validateAgent, AgentSchemaError, KNOWN_TOOLS } from './agent-schema.js';
import { retrieve } from './memory.js';
import { runCouncil, CouncilError } from './council.js';
import { HELP_TEXT } from './display.js';
import { stateLabel } from './verification.js';

export interface CommandResult {
  /** Text to show. */
  output: string;
  /** True when the client should exit. */
  quit?: boolean;
  /** True when this input was not a command and should go to the agent. */
  passthrough?: boolean;
}

/** True when `input` is a `:` command rather than a message. */
export function isCommand(input: string): boolean {
  return input.trimStart().startsWith(':');
}

/**
 * Executes one command.
 *
 * `prompt` is supplied by the CLI for the few commands that need to ask a
 * follow-up (creating an agent). It is absent in tests, where those commands
 * report what they would have asked for instead of blocking.
 */
export async function runCommand(
  session: OpOneSession,
  input: string,
  prompt?: (question: string) => Promise<string>,
): Promise<CommandResult> {
  const trimmed = input.trim();
  if (!isCommand(trimmed)) return { output: '', passthrough: true };

  const [rawCmd, ...rest] = trimmed.slice(1).split(/\s+/);
  const cmd = rawCmd.toLowerCase();
  const arg = rest.join(' ').trim();

  switch (cmd) {
    case 'help': return { output: HELP_TEXT };
    case 'quit': case 'exit': return { output: 'bye.', quit: true };
    case 'agent': return cmdAgent(session, arg, prompt);
    case 'model': return cmdModel(session, arg);
    case 'council': return cmdCouncil(session, arg);
    case 'mesh': return cmdMesh(session, arg);
    case 'verify': return cmdVerify(session);
    case 'memory': return cmdMemory(session, arg);
    case 'status': return cmdStatus(session);
    default:
      return { output: `unknown command ":${cmd}" — :help for the list` };
  }
}

// ── :agent ────────────────────────────────────────────────────────────────────

async function cmdAgent(
  session: OpOneSession,
  arg: string,
  prompt?: (q: string) => Promise<string>,
): Promise<CommandResult> {
  if (arg === 'new') return cmdAgentNew(prompt);

  const agents = agentStore.list();

  if (!arg) {
    const active = session.activeAgent();
    if (agents.length === 0) {
      return {
        output:
          `no agents defined — using the built-in default "${active.name}".\n` +
          `  :agent new  to create one`,
      };
    }
    const lines = agents.map(a =>
      `  ${a.id === active.id ? '*' : ' '} ${a.id.padEnd(18)} ${a.name} — ${a.purpose}`,
    );
    return { output: `agents:\n${lines.join('\n')}\n\n  :agent <id>  to switch` };
  }

  const found = agentStore.get(arg);
  if (!found) {
    return { output: `no agent "${arg}" — :agent to list` };
  }
  session.setAgent(found);
  preferencesStore.update({ defaultAgentId: found.id });
  return { output: `active agent: ${found.name} (${found.id})` };
}

async function cmdAgentNew(prompt?: (q: string) => Promise<string>): Promise<CommandResult> {
  if (!prompt) {
    return {
      output:
        'creating an agent needs an interactive terminal.\n' +
        'fields: id, name, purpose, instruction, permittedTools, modelPolicy, ' +
        'verificationPolicy, memoryScope',
    };
  }

  const id = (await prompt('id: ')).trim();
  const name = (await prompt('name: ')).trim();
  const purpose = (await prompt('purpose: ')).trim();
  const instruction = (await prompt('instruction: ')).trim();
  const toolsRaw = (await prompt(`tools (comma-separated; known: ${KNOWN_TOOLS.join(', ')}): `)).trim();
  const policyRaw = (await prompt('model policy [local-first|cloud-only|local-only|<model id>]: ')).trim();
  const verifyRaw = (await prompt('verification [always|on-code-change|manual]: ')).trim();
  const scopeRaw = (await prompt('memory scope [full|engineering|none]: ')).trim();

  const modelPolicy: AgentDefinition['modelPolicy'] =
    policyRaw === 'local-first' || policyRaw === 'cloud-only' || policyRaw === 'local-only'
      ? { kind: policyRaw }
      : { kind: 'pinned', model: policyRaw };

  try {
    const agent = validateAgent({
      id,
      name,
      purpose,
      instruction,
      permittedTools: toolsRaw.split(',').map(s => s.trim()).filter(Boolean),
      modelPolicy,
      verificationPolicy: verifyRaw,
      memoryScope: scopeRaw,
      createdAt: new Date().toISOString(),
    });
    agentStore.save(agent);
    return { output: `created agent "${agent.id}" — :agent ${agent.id} to use it` };
  } catch (e) {
    if (e instanceof AgentSchemaError) return { output: e.message };
    throw e;
  }
}

// ── :model ────────────────────────────────────────────────────────────────────

async function cmdModel(session: OpOneSession, arg: string): Promise<CommandResult> {
  if (!arg) {
    const override = session.activeModelOverride();
    const policy = session.activeAgent().modelPolicy;
    const policyText = policy.kind === 'pinned' ? `pinned:${policy.model}` : policy.kind;
    const last = session.lastResult();
    const actual = last
      ? `\n  last run used: ${last.model}${last.usedLocalModel ? ' (local)' : ''}`
      : '';
    return {
      output:
        `model override: ${override ?? '(none)'}\n` +
        `agent policy:   ${policyText}${actual}\n\n` +
        `  :model <id>    override for this session\n` +
        `  :model auto    clear the override, use the agent policy`,
    };
  }

  if (arg === 'auto' || arg === 'clear' || arg === 'none') {
    session.setModelOverride(undefined);
    return { output: 'model override cleared — the agent policy decides' };
  }

  session.setModelOverride(arg);
  return { output: `model override: ${arg}` };
}

// ── :council ──────────────────────────────────────────────────────────────────

/**
 * `:council <roles...> ? <question>` — roles before the `?`, question after.
 * Roles must be named explicitly; there is no default panel, because a council
 * whose composition nobody chose is just a more expensive single agent.
 */
async function cmdCouncil(session: OpOneSession, arg: string): Promise<CommandResult> {
  if (!arg) {
    return {
      output:
        'usage: :council <role1,role2,...> ? <one question>\n' +
        '  e.g. :council security,performance,api-design ? should we cache the token endpoint',
    };
  }

  const idx = arg.indexOf('?');
  if (idx === -1) {
    return { output: 'a council needs roles and one question, separated by "?" — :council for usage' };
  }

  const roles = arg.slice(0, idx).split(',').map(s => s.trim()).filter(Boolean);
  const question = arg.slice(idx + 1).trim();

  try {
    const outcome = await runCouncil(session.engine, {
      projectRoot: session.projectRoot,
      question,
      roles,
      model: session.activeModelOverride() ?? 'default',
    });

    const parts = [
      `council — ${outcome.seats.length}/${outcome.roles.length} seats answered`,
      '',
      'agreements:',
      ...(outcome.agreements.length
        ? outcome.agreements.map(a => `  · ${a}`)
        : ['  (none identified)']),
      '',
      'disagreements:',
      ...(outcome.disagreements.length
        ? outcome.disagreements.map(d => `  · ${d}`)
        : ['  (none identified)']),
      '',
      'synthesis:',
      `  ${outcome.synthesis.replace(/\n/g, '\n  ')}`,
      '',
      `verification: ${stateLabel(outcome.verification.state)} — ${outcome.verification.decision}`,
    ];
    if (outcome.failures > 0) parts.push(`note: ${outcome.failures} seat(s) failed to answer`);

    return { output: parts.join('\n') };
  } catch (e) {
    if (e instanceof CouncilError) return { output: `council: ${e.message}` };
    throw e;
  }
}

// ── :mesh ─────────────────────────────────────────────────────────────────────

async function cmdMesh(session: OpOneSession, arg: string): Promise<CommandResult> {
  const prefs = session.preferences();

  if (!arg) {
    const rules = prefs.mesh.rules.length
      ? prefs.mesh.rules.map(r => `    · ${r.match} — ${r.reason}`).join('\n')
      : '    (none)';
    return {
      output:
        `Agent Mesh: ${prefs.mesh.enabled ? 'on' : 'off (default)'}\n` +
        `  endpoint: ${prefs.mesh.endpoint ?? '(none configured)'}\n` +
        `  routing rules:\n${rules}\n\n` +
        `  :mesh on | :mesh off\n` +
        `  :mesh run <task>   delegate one task explicitly\n\n` +
        `Aura OP One keeps intent, permissions, verification and recording ` +
        `regardless — the mesh only executes.`,
    };
  }

  if (arg === 'on' || arg === 'off') {
    session.setMeshEnabled(arg === 'on');
    return { output: `Agent Mesh: ${arg}` };
  }

  if (arg.startsWith('run ')) {
    const task = arg.slice(4).trim();
    if (!task) return { output: 'usage: :mesh run <task>' };
    const result = await session.handle(task, { mesh: true });
    return { output: formatTurn(result) };
  }

  return { output: 'usage: :mesh [on|off|run <task>]' };
}

// ── :verify ───────────────────────────────────────────────────────────────────

async function cmdVerify(session: OpOneSession): Promise<CommandResult> {
  const record = await session.verifyLast();
  if (!record) return { output: 'nothing to verify yet' };

  const checks = record.checks.length
    ? record.checks.map(c => `  ${c.passed ? '✓' : '✗'} ${c.name}: ${c.detail}`).join('\n')
    : '  (no checks ran)';

  return {
    output:
      `verification: ${stateLabel(record.state)}\n` +
      `decision: ${record.decision}\n` +
      `checks:\n${checks}\n` +
      `evidence: ${record.evidence.filesChanged.length} file(s) changed, ` +
      `${record.evidence.testsExecuted.length} test command(s) run`,
  };
}

// ── :memory ───────────────────────────────────────────────────────────────────

async function cmdMemory(session: OpOneSession, arg: string): Promise<CommandResult> {
  if (!arg) {
    const episodes = opOneEpisodeStore.list();
    const verified = episodes.filter(e => e.verification.state === 'verified').length;
    return {
      output:
        `memory:\n` +
        `  conversations : this session is ${session.conversationId}\n` +
        `  episodes      : ${episodes.length} (${verified} verified)\n` +
        `  agents        : ${agentStore.list().length}\n` +
        `  preferences   : ${session.preferences().notes.length} note(s)\n\n` +
        `  :memory <query>  show what would be retrieved`,
    };
  }

  const hits = retrieve({
    query: arg,
    scope: session.activeAgent().memoryScope,
    projectRoot: session.projectRoot,
    conversationId: session.conversationId,
    limit: 10,
  });

  if (hits.length === 0) return { output: `nothing retrieved for "${arg}"` };

  const lines = hits.map(
    h => `  [${h.record.provenance.verification}] ${h.record.category}: ` +
      `${h.record.text.slice(0, 90).replace(/\n/g, ' ')}\n      ${h.reason}`,
  );
  return { output: `retrieved for "${arg}":\n${lines.join('\n')}` };
}

// ── :status ───────────────────────────────────────────────────────────────────

async function cmdStatus(session: OpOneSession): Promise<CommandResult> {
  const agent = session.activeAgent();
  const last = session.lastResult();
  const prefs = session.preferences();

  const lines = [
    `agent        : ${agent.name} (${agent.id})`,
    `model        : ${session.activeModelOverride() ?? `policy:${agent.modelPolicy.kind}`}`,
    `verification : ${last ? stateLabel(last.verification.state) : '(no turn yet)'}`,
    `mesh         : ${prefs.mesh.enabled ? 'on' : 'off'}`,
    `conversation : ${session.conversationId}`,
  ];

  if (last) {
    lines.push(
      '',
      `last turn    : ${last.mode}, ${last.model}${last.usedLocalModel ? ' (local)' : ''}`,
      `  retrieval ${last.timings.retrievalMs}ms · select ${last.timings.modelSelectionMs}ms · ` +
        `exec ${last.timings.executionMs}ms · verify ${last.timings.verificationMs}ms · ` +
        `total ${last.timings.totalMs}ms`,
      `  tokens ${last.episode.tokens.input} in / ${last.episode.tokens.output} out`,
    );
    if (last.fallback) {
      lines.push(`  fallback: ${last.fallback.from} → ${last.fallback.to} (${last.fallback.reason})`);
    }
    if (last.deniedActions.length) {
      lines.push(`  denied: ${last.deniedActions.map(d => `${d.tool} (${d.reason})`).join(', ')}`);
    }
  }

  return { output: lines.join('\n') };
}

// ── shared formatting ─────────────────────────────────────────────────────────

/** Renders a turn: the reply, then the verification state. Nothing else. */
export function formatTurn(result: {
  reply: string;
  verification: { state: Parameters<typeof stateLabel>[0]; decision: string };
  fallback?: { from: string; to: string; reason: string };
  deniedActions: Array<{ tool: string; reason: string }>;
}): string {
  const parts = [result.reply, '', `— ${stateLabel(result.verification.state)}`];
  if (result.fallback) {
    parts.push(`— fallback: ${result.fallback.from} → ${result.fallback.to} (${result.fallback.reason})`);
  }
  for (const d of result.deniedActions) {
    parts.push(`— denied: ${d.tool} (${d.reason})`);
  }
  return parts.join('\n');
}
