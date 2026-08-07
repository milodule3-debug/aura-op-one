// ─────────────────────────────────────────────────────────────────────────────
// Aura OP One — line input
// ─────────────────────────────────────────────────────────────────────────────
//
// `readline.question` only captures the *next* line at the moment it is called.
// With piped stdin every line arrives at once, so all but the first are dropped
// and a scripted session silently executes one command and stops.
//
// A queue fixes that: lines are buffered as they arrive and handed out in order,
// which makes the client behave the same interactively and when driven by a
// script — the latter being what makes the end-to-end demo reproducible.

import type * as readline from 'readline';

export interface LineReader {
  /** Prompts and resolves with the next line, or '' once input has ended. */
  ask(prompt: string): Promise<string>;
  /** True once stdin has closed and the queue is drained. */
  readonly ended: boolean;
  close(): void;
}

export function createLineReader(
  rl: Pick<readline.Interface, 'on' | 'close' | 'setPrompt' | 'prompt'>,
  out: NodeJS.WritableStream = process.stdout,
): LineReader {
  /** Lines received but not yet requested. */
  const buffered: string[] = [];
  /** Callers waiting on a line that has not arrived. */
  const waiting: Array<(line: string) => void> = [];
  let closed = false;

  rl.on('line', (line: string) => {
    const next = waiting.shift();
    if (next) next(line);
    else buffered.push(line);
  });

  rl.on('close', () => {
    closed = true;
    // Everyone still waiting gets EOF rather than hanging forever.
    while (waiting.length) waiting.shift()!('');
  });

  return {
    get ended() {
      return closed && buffered.length === 0;
    },

    ask(prompt: string): Promise<string> {
      if (buffered.length > 0) {
        // Echo the prompt so a piped transcript reads like a real session.
        out.write(prompt);
        const line = buffered.shift()!;
        out.write(`${line}\n`);
        return Promise.resolve(line);
      }
      if (closed) return Promise.resolve('');

      out.write(prompt);
      return new Promise<string>(resolve => waiting.push(resolve));
    },

    close() {
      rl.close();
    },
  };
}
