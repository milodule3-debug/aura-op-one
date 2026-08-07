import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runCommand, isCommand, formatTurn } from '../src/commands.js';
import { OpOneSession } from '../src/session.js';
import { agentStore, knowledgeStore, preferencesStore } from '../src/stores.js';
import { defaultAgent } from '../src/agent-schema.js';
import { renderStatusLine } from '../src/display.js';
import { createFakeEngine } from './fake-engine.js';

let tmp: string;
let prevDir: string | undefined;
let session: OpOneSession;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opone-cmd-'));
  prevDir = process.env.AURA_OP_ONE_DIR;
  process.env.AURA_OP_ONE_DIR = tmp;
  session = new OpOneSession({ engine: createFakeEngine(), projectRoot: '/proj' });
});

afterEach(() => {
  if (prevDir === undefined) delete process.env.AURA_OP_ONE_DIR;
  else process.env.AURA_OP_ONE_DIR = prevDir;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('command dispatch', () => {
  it('recognises commands and passes everything else through to the agent', async () => {
    expect(isCommand(':status')).toBe(true);
    expect(isCommand('  :help')).toBe(true);
    expect(isCommand('hello there')).toBe(false);

    expect((await runCommand(session, 'hello there')).passthrough).toBe(true);
  });

  it('implements every command the brief lists', async () => {
    for (const cmd of [':agent', ':model', ':mesh', ':verify', ':memory', ':status', ':help']) {
      const result = await runCommand(session, cmd);
      expect(result.output, cmd).toBeTruthy();
      expect(result.output, cmd).not.toMatch(/^unknown command/);
    }
    // :council needs arguments, and says so rather than failing.
    expect((await runCommand(session, ':council')).output).toContain('usage');
  });

  it('reports an unknown command instead of guessing', async () => {
    expect((await runCommand(session, ':wat')).output).toMatch(/unknown command ":wat"/);
  });

  it('quits on :quit', async () => {
    expect((await runCommand(session, ':quit')).quit).toBe(true);
  });
});

describe(':agent', () => {
  it('lists agents and marks the active one', async () => {
    agentStore.create({ ...defaultAgent(), id: 'reviewer', name: 'Reviewer' });
    agentStore.create({ ...defaultAgent(), id: 'writer', name: 'Writer' });
    session.setAgent(agentStore.get('writer')!);

    const out = (await runCommand(session, ':agent')).output;
    expect(out).toContain('reviewer');
    expect(out).toMatch(/\*\s+writer/);
  });

  it('switches the active agent and persists the choice', async () => {
    agentStore.create({ ...defaultAgent(), id: 'reviewer', name: 'Reviewer' });
    await runCommand(session, ':agent reviewer');

    expect(session.activeAgent().id).toBe('reviewer');
    expect(preferencesStore.load().defaultAgentId).toBe('reviewer');
  });

  it('reports an unknown agent', async () => {
    expect((await runCommand(session, ':agent ghost')).output).toContain('no agent "ghost"');
  });

  it('creates an agent from interactive answers', async () => {
    const answers = [
      'linter', 'Linter', 'Runs lint.', 'Run the linter and report.',
      'read_file,run_shell', 'cloud-only', 'manual', 'engineering',
    ];
    let i = 0;
    const out = (await runCommand(session, ':agent new', async () => answers[i++])).output;

    expect(out).toContain('created agent "linter"');
    const created = agentStore.get('linter')!;
    expect(created.permittedTools).toEqual(['read_file', 'run_shell']);
    expect(created.modelPolicy).toEqual({ kind: 'cloud-only' });
    expect(created.memoryScope).toBe('engineering');
  });

  it('reports schema problems instead of storing a broken agent', async () => {
    const answers = ['bad id', 'N', 'p', 'i', 'not_a_tool', 'cloud-only', 'never', 'everything'];
    let i = 0;
    const out = (await runCommand(session, ':agent new', async () => answers[i++])).output;

    expect(out).toContain('invalid agent definition');
    expect(agentStore.list()).toHaveLength(0);
  });
});

describe(':model', () => {
  it('shows the policy and the override', async () => {
    const out = (await runCommand(session, ':model')).output;
    expect(out).toContain('model override: (none)');
    expect(out).toContain('agent policy:   local-first');
  });

  it('sets and clears the override', async () => {
    await runCommand(session, ':model gpt-4o');
    expect(session.activeModelOverride()).toBe('gpt-4o');

    await runCommand(session, ':model auto');
    expect(session.activeModelOverride()).toBeUndefined();
  });

  it('reports the model that actually ran, not the one requested', async () => {
    const engine = createFakeEngine({ localAvailable: false });
    const s = new OpOneSession({ engine, projectRoot: '/proj' });
    await s.handle('do a thing');

    expect((await runCommand(s, ':model')).output).toContain('last run used: cloud-model');
  });
});

describe(':mesh', () => {
  it('shows mesh off by default, with its rules', async () => {
    const out = (await runCommand(session, ':mesh')).output;
    expect(out).toContain('Agent Mesh: off (default)');
    expect(out).toContain('routing rules:');
    expect(out).toContain('(none)');
  });

  it('toggles the mesh', async () => {
    await runCommand(session, ':mesh on');
    expect(session.meshEnabled()).toBe(true);
    await runCommand(session, ':mesh off');
    expect(session.meshEnabled()).toBe(false);
  });

  it('runs a delegated task, falling back locally while no transport exists', async () => {
    await runCommand(session, ':mesh on');
    const out = (await runCommand(session, ':mesh run tidy the imports')).output;
    expect(out).toBeTruthy();
  });

  it('rejects malformed usage', async () => {
    expect((await runCommand(session, ':mesh sideways')).output).toContain('usage:');
    expect((await runCommand(session, ':mesh run ')).output).toContain('usage:');
  });
});

describe(':council', () => {
  it('requires roles and a question separated by "?"', async () => {
    expect((await runCommand(session, ':council security,perf')).output)
      .toMatch(/roles and one question/);
  });

  it('reports seats, agreements, synthesis and verification state', async () => {
    const engine = createFakeEngine({
      verifyPasses: true,
      councilAnswers: {
        security: 'We should rate limit the token endpoint before caching it.',
        performance: 'We should rate limit the token endpoint before caching it.',
      },
      run: req => (req.task.startsWith('Synthesise') ? { summary: 'Rate limit first.' } : {}),
    });
    const s = new OpOneSession({ engine, projectRoot: '/proj' });

    const out = (await runCommand(s, ':council security,performance ? should we cache tokens')).output;
    expect(out).toContain('2/2 seats answered');
    expect(out).toContain('agreements:');
    expect(out).toContain('Rate limit first.');
    expect(out).toContain('verification: verified');
  });

  it('surfaces a council error rather than throwing', async () => {
    const engine = createFakeEngine({ councilFailures: ['a'] });
    const s = new OpOneSession({ engine, projectRoot: '/proj' });
    expect((await runCommand(s, ':council a ? q')).output).toContain('council:');
  });
});

describe(':memory', () => {
  it('summarises the separate stores', async () => {
    const out = (await runCommand(session, ':memory')).output;
    expect(out).toContain('conversations');
    expect(out).toContain('episodes');
    expect(out).toContain('agents');
    expect(out).toContain('preferences');
  });

  it('shows retrieved records with their verification state and ranking reason', async () => {
    knowledgeStore.save({
      text: 'the retry budget is four attempts',
      provenance: {
        source: 'test', createdAt: new Date().toISOString(),
        confidence: 0.9, verification: 'verified', projectRoot: '/proj',
      },
    });

    const out = (await runCommand(session, ':memory retry budget')).output;
    expect(out).toContain('[verified]');
    expect(out).toContain('verified engineering experience');
  });

  it('says so when nothing matches', async () => {
    expect((await runCommand(session, ':memory zzzz')).output).toContain('nothing retrieved');
  });
});

describe(':verify and :status', () => {
  it('says there is nothing to verify before a turn', async () => {
    expect((await runCommand(session, ':verify')).output).toBe('nothing to verify yet');
  });

  it('reports the gate decision, checks and evidence', async () => {
    const engine = createFakeEngine({
      verifyPasses: true,
      run: { toolCalls: [
        { name: 'edit_file', input: { path: 'a.ts' } },
        { name: 'run_shell', input: { command: 'npm test' } },
      ] },
    });
    const s = new OpOneSession({ engine, projectRoot: '/proj' });
    await s.handle('change a file');

    const out = (await runCommand(s, ':verify')).output;
    expect(out).toContain('verification: verified');
    expect(out).toContain('1 file(s) changed');
    expect(out).toContain('1 test command(s) run');
  });

  it(':status shows only agent, model, verification, mesh and the last turn', async () => {
    const engine = createFakeEngine({ localAvailable: false, run: { toolCalls: [] } });
    const s = new OpOneSession({ engine, projectRoot: '/proj' });
    await s.handle('a task');

    const out = (await runCommand(s, ':status')).output;
    expect(out).toContain('agent        :');
    expect(out).toContain('verification :');
    expect(out).toContain('mesh         : off');
    expect(out).toContain('fallback: local-model → cloud-model');
    // No dashboards, graphs or telemetry on the default surface.
    expect(out).not.toMatch(/graph|dashboard|telemetry/i);
  });
});

describe('default screen rendering', () => {
  it('shows agent, model and verification state, and hides mesh while it is off', () => {
    const line = renderStatusLine({
      agentName: 'Fixer', model: 'local-model', isLocal: true,
      verification: 'verified', meshEnabled: false,
    }, false);

    expect(line).toContain('Fixer');
    expect(line).toContain('local-model (local)');
    expect(line).toContain('verified');
    expect(line).not.toContain('mesh');
  });

  it('shows mesh once it is on', () => {
    const line = renderStatusLine({
      agentName: 'Fixer', model: 'm', isLocal: false,
      verification: 'unverified', meshEnabled: true,
    }, false);
    expect(line).toContain('mesh:on');
  });

  it('renders a turn as reply plus verification state, and names fallbacks and denials', () => {
    const out = formatTurn({
      reply: 'done',
      verification: { state: 'rejected', decision: 'no' },
      fallback: { from: 'mesh:x', to: 'local-agent', reason: 'unavailable' },
      deniedActions: [{ tool: 'run_shell', reason: 'not granted' }],
    });

    expect(out).toContain('done');
    expect(out).toContain('— rejected');
    expect(out).toContain('mesh:x → local-agent');
    expect(out).toContain('denied: run_shell');
  });
});
