# Aura OP One — instructions for agents in this repo

**Aura OP One** is the minimal personal and agentic client for the Aura ecosystem.
Shell command **`opone`**. Full design: `AURA_OP_ONE_ARCHITECTURE.md`.

Canonical loop: *request → retrieve experience → select agent/model → act →
verify → record episode → improve future routing*.

- **Package:** `aura-op-one`, binary `opone` (`dist/cli.js`)
- **Language:** TypeScript (strict), CommonJS, Node ≥ 18
- **Depends on:** `aura-code` (npm, `^0.14.0`) — the engine
- **License:** MIT

---

## This is a client, not a second engine

Execution, tools, providers, the verification gate, permissions and credentials
all live in `aura-code`. This repo owns the *experience*: what the user sees,
what is remembered about them, which agent acts, and whether a result may be
called verified.

**Never reimplement an `aura-code` capability here.** If something is missing,
add it to `aura-code` and consume it across the seam.

## The one rule that matters

`src/engine.ts` is the **only** file allowed to import `aura-code`. Everything
else depends on the `Engine` interface it declares.

If you need a new engine capability, **add a method to `Engine` and implement it
in `engine.ts`** — do not import `aura-code` from `session.ts`, `memory.ts`,
`commands.ts` or anywhere else. `tests/fake-engine.ts` substitutes for the real
engine, so breaking this rule also breaks the suite's ability to run without a
provider, a network, or an API key. That the tests run offline *is* the proof the
boundary holds; treat a test that suddenly needs a key as a boundary violation,
not a test problem.

Imports reach `aura-code` through its published `dist/`
(`aura-code/dist/agent/loop.js`) because the package declares no `exports` map.
Keep every such path inside `engine.ts`.

## Invariants — do not weaken these

- `verified` is reachable **only** from `verification_pending`, and only when the
  gate approved. A gate that throws yields `escalated`, never a pass. Never
  display or store `verified` for output the gate did not approve.
- Illegal verification transitions **throw** rather than coerce — a silent coercion
  surfaces as a wrong badge in the UI, which is the exact failure the state
  machine exists to prevent.
- Verified engineering experience outranks unverified conversation by a
  *dominating tier* in `memory.ts`, not a weight. Do not "rebalance" those into
  comparable numbers — the gap has to exceed any achievable match score.
- `knowledgeStore` accepts **verified items only**; it throws otherwise.
- Agent Mesh is off by default in config *and* in code (the default transport is
  never available). Mesh-reported actions are re-checked locally — against both
  the delegated tool grant and the permission system — before counting as
  evidence.
- Commits need verification **and** explicit user approval. There is no
  auto-commit path, and `confirm` defaults to refusing.
- Anything bound for a store, a log, or the UI goes through `redactSecrets` /
  `redactValue` first.

## Storage

Six **separate** categories under `~/.aura/op-one/`: conversations, preferences,
agents, knowledge, episodes — plus in-memory scratch. Do not merge them into one
store; the separation is what makes an agent's memory scope enforceable.

Override the root with `AURA_OP_ONE_DIR`. **Always set it in tests** so nothing
touches the user's real data.

## The default screen

Conversation, active agent, active model, verification state, and `:help`.
Nothing else. No graphs, dashboards, telemetry, or routing internals — that
surface belongs to aura-pulse.

## Build, run, test

```bash
npm install
npm run build          # tsc -> dist/
npm test               # vitest run — 172 tests, no provider needed
node dist/cli.js --help
AURA_OP_ONE_DIR=/tmp/x node dist/cli.js    # isolate its stores
```

## Deferred on purpose (architecture §13)

Autonomous agent generation · large graphical dashboard · any aura-pulse
replacement · mobile app · voice/avatar · marketplace · background autonomous
operation · automatic fine-tuning · a vector database · a second verification
system · a second orchestration engine.

Aura OP One does nothing on a schedule. It acts only when someone types into it.
