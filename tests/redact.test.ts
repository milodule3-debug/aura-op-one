import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { redactSecrets, redactValue } from '../src/redact.js';
import { conversationStore, opOneEpisodeStore } from '../src/stores.js';
import { OpOneSession } from '../src/session.js';
import { createFakeEngine } from './fake-engine.js';

let tmp: string;
let prevDir: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opone-redact-'));
  prevDir = process.env.AURA_OP_ONE_DIR;
  process.env.AURA_OP_ONE_DIR = tmp;
});

afterEach(() => {
  if (prevDir === undefined) delete process.env.AURA_OP_ONE_DIR;
  else process.env.AURA_OP_ONE_DIR = prevDir;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('credential redaction', () => {
  it('redacts key/token/secret assignments while keeping the variable name', () => {
    expect(redactSecrets('ANTHROPIC_API_KEY=sk-ant-abcdefgh12345678'))
      .toBe('ANTHROPIC_API_KEY=[redacted]');
    expect(redactSecrets('export OPENAI_API_KEY="sk-proj-abcdefgh12345678"'))
      .toContain('OPENAI_API_KEY=');
    expect(redactSecrets('export OPENAI_API_KEY="sk-proj-abcdefgh12345678"'))
      .not.toContain('sk-proj-abcdefgh12345678');
  });

  it('redacts bearer tokens', () => {
    const out = redactSecrets('Authorization: Bearer abc123def456ghi789');
    expect(out).toContain('Bearer [redacted]');
    expect(out).not.toContain('abc123def456ghi789');
  });

  it('redacts vendor key shapes wherever they appear', () => {
    for (const secret of [
      'sk-ant-api03-AAAABBBBCCCCDDDD',
      'sk-abcdefghijklmnopqrstuvwx',
      'ghp_abcdefghijklmnopqrst',
      'AIzaSyAbcdefghijklmnopqrstuvwxyz12',
      'xai-abcdefghijklmnopqrst',
    ]) {
      const out = redactSecrets(`the value is ${secret} in prose`);
      expect(out, secret).not.toContain(secret);
      expect(out, secret).toContain('[redacted]');
    }
  });

  it('leaves ordinary text alone', () => {
    const text = 'fixed the pagination off-by-one in src/utils/pagination.js';
    expect(redactSecrets(text)).toBe(text);
  });

  it('handles empty input', () => {
    expect(redactSecrets('')).toBe('');
  });

  it('redacts sensitive object keys outright, whatever the value looks like', () => {
    const out = redactValue({
      command: 'curl -H "Authorization: Bearer abc123def456ghi789" https://api.example.com',
      api_key: 'anything-at-all',
      nested: { password: 'hunter2', safe: 'keep me' },
      list: ['MY_SECRET_TOKEN=sk-abcdefghijklmnopqrstuvwx'],
    });

    expect(out.api_key).toBe('[redacted]');
    expect(out.nested.password).toBe('[redacted]');
    expect(out.nested.safe).toBe('keep me');
    expect(out.command).toContain('[redacted]');
    expect(out.list[0]).not.toContain('sk-abcdefghijklmnopqrstuvwx');
  });

  it('does not recurse forever on a cyclic-looking deep structure', () => {
    let deep: Record<string, unknown> = { value: 'sk-abcdefghijklmnopqrstuvwx' };
    for (let i = 0; i < 30; i++) deep = { nested: deep };
    expect(() => redactValue(deep)).not.toThrow();
  });
});

describe('secrets never reach the stores or the UI', () => {
  it('redacts conversation turns before they touch disk', async () => {
    const conv = conversationStore.create();
    conversationStore.append(conv.id, {
      role: 'user',
      content: 'use ANTHROPIC_API_KEY=sk-ant-abcdefgh12345678 for this',
      at: new Date().toISOString(),
    });

    const raw = fs.readFileSync(conversationStore.filePath(conv.id), 'utf8');
    expect(raw).not.toContain('sk-ant-abcdefgh12345678');
    expect(raw).toContain('[redacted]');
  });

  it('redacts the request, summary and evidence stored in an episode', async () => {
    const engine = createFakeEngine({
      run: {
        summary: 'ran with OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwx',
        toolCalls: [
          { name: 'run_shell', input: { command: 'ANTHROPIC_API_KEY=sk-ant-abcdefgh12345678 npm test' } },
          { name: 'edit_file', input: { path: 'a.ts' } },
        ],
      },
      verifyPasses: true,
    });
    const session = new OpOneSession({ engine, projectRoot: '/proj' });
    const turn = await session.handle('deploy with GH_TOKEN=ghp_abcdefghijklmnopqrst please');

    const raw = fs.readFileSync(opOneEpisodeStore.filePath(turn.episode.id), 'utf8');
    for (const secret of [
      'sk-abcdefghijklmnopqrstuvwx',
      'sk-ant-abcdefgh12345678',
      'ghp_abcdefghijklmnopqrst',
    ]) {
      expect(raw, secret).not.toContain(secret);
    }
    expect(raw).toContain('[redacted]');
  });

  it('redacts the reply shown to the user', async () => {
    const engine = createFakeEngine({
      run: { summary: 'the key is sk-ant-abcdefgh12345678', toolCalls: [] },
    });
    const session = new OpOneSession({ engine, projectRoot: '/proj' });
    const turn = await session.handle('what is the key');

    expect(turn.reply).not.toContain('sk-ant-abcdefgh12345678');
    expect(turn.reply).toContain('[redacted]');
  });
});
