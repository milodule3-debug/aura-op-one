#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Aura OP One — terminal client
// ─────────────────────────────────────────────────────────────────────────────
//
// The default screen shows only: conversation, active agent, active model,
// verification state, and how to reach help. Everything else is behind a `:`
// command. This is a read-eval-print shell over ./commands.ts and ./session.ts —
// it holds no logic of its own beyond wiring and prompting.

import * as readline from 'readline';
import { createLineReader } from './line-reader.js';
import { OpOneSession } from './session.js';
import { createAuraCodeEngine } from './engine.js';
import { runCommand, isCommand, formatTurn } from './commands.js';
import { renderStatusLine, renderAssistant, HELP_TEXT } from './display.js';
import { PRODUCT_NAME } from './types.js';
import { conversationStore } from './stores.js';

export interface CliOptions {
  projectRoot?: string;
  /** Resume an existing conversation. */
  conversationId?: string;
  testCommand?: string;
  permissionLevel?: 'read-only' | 'normal' | 'auto';
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const startedAt = Date.now();
  const opts = parseArgs(argv);

  if (opts.help) {
    process.stdout.write(`${PRODUCT_NAME}\n\n${HELP_TEXT}\n`);
    return 0;
  }

  const projectRoot = opts.projectRoot ?? process.cwd();
  const engine = createAuraCodeEngine({
    permissionLevel: opts.permissionLevel ?? 'normal',
    testCommand: opts.testCommand,
  });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const input = createLineReader(rl);

  const session = new OpOneSession({
    engine,
    projectRoot,
    conversationId: opts.conversationId,
    testCommand: opts.testCommand,
    // Consequential actions ask. A non-"y" answer is a no.
    confirm: async (message: string) => {
      const answer = await input.ask(`\n${message}\n  [y/N] `);
      return /^y(es)?$/i.test(answer.trim());
    },
  });

  process.stdout.write(`${PRODUCT_NAME} — :help for commands\n`);
  process.stdout.write(`ready in ${Date.now() - startedAt}ms\n\n`);

  try {
    for (;;) {
      const status = renderStatusLine({
        agentName: session.activeAgent().name,
        model: session.activeModelOverride() ?? session.activeAgent().modelPolicy.kind,
        isLocal: session.lastResult()?.usedLocalModel ?? false,
        verification: session.lastResult()?.verification.state ?? 'unverified',
        meshEnabled: session.meshEnabled(),
      });
      process.stdout.write(`${status}\n`);

      const line = (await input.ask('› ')).trim();
      if (input.ended && !line) return 0;
      if (!line) continue;

      if (isCommand(line)) {
        const result = await runCommand(session, line, q => input.ask(q));
        if (result.output) process.stdout.write(`${result.output}\n\n`);
        if (result.quit) return 0;
        continue;
      }

      const t0 = Date.now();
      const turn = await session.handle(line);
      const firstResponseMs = Date.now() - t0;

      process.stdout.write(`\n${renderAssistant(formatTurn(turn))}\n`);
      process.stdout.write(`  ${firstResponseMs}ms\n\n`);
    }
  } catch (e) {
    process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  } finally {
    input.close();
  }
}

interface ParsedArgs extends CliOptions {
  help?: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--root') out.projectRoot = argv[++i];
    else if (a === '--resume') out.conversationId = argv[++i];
    else if (a === '--test-command') out.testCommand = argv[++i];
    else if (a === '--readonly') out.permissionLevel = 'read-only';
    else if (a === '--auto') out.permissionLevel = 'auto';
  }
  return out;
}

/** Most recent conversation id, for `--resume` with no argument. */
export function latestConversationId(): string | undefined {
  return conversationStore.list()[0]?.id;
}

if (require.main === module) {
  main().then(code => process.exit(code));
}
