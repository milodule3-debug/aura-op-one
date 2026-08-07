// ─────────────────────────────────────────────────────────────────────────────
// Aura OP One — display adapters
// ─────────────────────────────────────────────────────────────────────────────
//
// aura-code's `Display` is a 20+ method terminal-shaped interface (architecture
// §14.7). Aura OP One's surface is deliberately quieter than the aura-code TUI,
// so rather than render every loop event it supplies a silent implementation
// and shows only what the default screen is allowed to show:
//
//   conversation · active agent · active model · verification state · :help
//
// No graphs, no telemetry, no routing internals.

import type { VerificationState } from './types.js';
import { stateLabel } from './verification.js';
import { redactSecrets } from './redact.js';

/**
 * A no-op `Display` for the aura-code loop.
 *
 * Typed structurally rather than importing `Display` so this module — and
 * everything that tests it — stays free of the CLI dependency tree.
 */
export function createSilentDisplay(): Record<string, (...args: never[]) => void> {
  const noop = () => {};
  return {
    agentThinking: noop,
    streamText: noop,
    streamEnd: noop,
    toolStart: noop,
    toolCall: noop,
    toolResult: noop,
    toolBlocked: noop,
    warning: noop,
    success: noop,
    error: noop,
    header: noop,
    summary: noop,
    showPlan: noop,
    stepStarted: noop,
    stepCompleted: noop,
    contextBar: noop,
    contextDashboard: noop,
    compactionEvent: noop,
    stopThinking: noop,
    retry: noop,
    failover: noop,
    circuit: noop,
  };
}

/** What the client is allowed to render on the default screen. */
export interface StatusLine {
  agentName: string;
  model: string;
  isLocal: boolean;
  verification: VerificationState;
  meshEnabled: boolean;
}

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

function color(state: VerificationState): string {
  switch (state) {
    case 'verified': return '\x1b[32m';               // green
    case 'rejected': return '\x1b[31m';               // red
    case 'escalated': return '\x1b[33m';              // yellow
    case 'verification_pending': return '\x1b[36m';   // cyan
    case 'unverified': return DIM;
  }
}

/**
 * The one-line status bar. Mesh appears only when it is on — an off-by-default
 * feature should not occupy the calm default screen.
 */
export function renderStatusLine(s: StatusLine, useColor = true): string {
  const c = (code: string, text: string) => (useColor ? `${code}${text}${RESET}` : text);
  const parts = [
    c(BOLD, s.agentName),
    `${s.model}${s.isLocal ? ' (local)' : ''}`,
    c(color(s.verification), stateLabel(s.verification)),
  ];
  if (s.meshEnabled) parts.push('mesh:on');
  return c(DIM, '· ') + parts.join(c(DIM, '  ·  '));
}

/** Assistant output. Redacted on the way to the terminal, like everything else. */
export function renderAssistant(text: string): string {
  return redactSecrets(text);
}

export const HELP_TEXT = `Aura OP One — commands

  :agent            list agents, or  :agent <id>  to switch
  :agent new        create an agent interactively
  :model            show the active model, or  :model <id>  to override
  :council          ask one question of an explicitly chosen panel
  :mesh             show mesh state;  :mesh on|off  to toggle (off by default)
  :verify           verify the last output
  :memory           show what would be retrieved for a query
  :status           session state
  :help             this text
  :quit             exit

Anything else is a message to the active agent.`;
