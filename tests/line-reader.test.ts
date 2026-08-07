import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import { createLineReader } from '../src/line-reader.js';

/** Minimal stand-in for the readline interface the reader consumes. */
function fakeRl() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    close() { emitter.emit('close'); },
    setPrompt() {},
    prompt() {},
  }) as unknown as Parameters<typeof createLineReader>[0] & EventEmitter;
}

function sink() {
  const written: string[] = [];
  return {
    written,
    stream: { write: (s: string) => { written.push(s); return true; } } as unknown as NodeJS.WritableStream,
  };
}

describe('line reader', () => {
  it('resolves a pending ask when the line arrives', async () => {
    const rl = fakeRl();
    const out = sink();
    const reader = createLineReader(rl, out.stream);

    const pending = reader.ask('› ');
    rl.emit('line', 'hello');
    expect(await pending).toBe('hello');
    expect(out.written).toContain('› ');
  });

  it('buffers lines that arrive before they are asked for — the piped-stdin case', async () => {
    const rl = fakeRl();
    const reader = createLineReader(rl, sink().stream);

    // All lines arrive at once, as they do from a pipe.
    rl.emit('line', ':status');
    rl.emit('line', ':mesh');
    rl.emit('line', ':quit');

    expect(await reader.ask('› ')).toBe(':status');
    expect(await reader.ask('› ')).toBe(':mesh');
    expect(await reader.ask('› ')).toBe(':quit');
  });

  it('preserves order when buffered and pending reads interleave', async () => {
    const rl = fakeRl();
    const reader = createLineReader(rl, sink().stream);

    rl.emit('line', 'first');
    const a = await reader.ask('› ');
    const pending = reader.ask('› ');
    rl.emit('line', 'second');

    expect(a).toBe('first');
    expect(await pending).toBe('second');
  });

  it('releases a waiting caller on close instead of hanging', async () => {
    const rl = fakeRl();
    const reader = createLineReader(rl, sink().stream);

    const pending = reader.ask('› ');
    rl.emit('close');
    expect(await pending).toBe('');
    expect(reader.ended).toBe(true);
  });

  it('drains buffered lines before reporting ended', async () => {
    const rl = fakeRl();
    const reader = createLineReader(rl, sink().stream);

    rl.emit('line', 'leftover');
    rl.emit('close');

    expect(reader.ended).toBe(false);
    expect(await reader.ask('› ')).toBe('leftover');
    expect(reader.ended).toBe(true);
    expect(await reader.ask('› ')).toBe('');
  });

  it('echoes buffered lines so a piped transcript reads like a session', async () => {
    const rl = fakeRl();
    const out = sink();
    const reader = createLineReader(rl, out.stream);

    rl.emit('line', ':status');
    await reader.ask('› ');

    expect(out.written.join('')).toBe('› :status\n');
  });
});
