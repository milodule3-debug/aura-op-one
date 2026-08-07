# Aura OP One

**The minimal personal and agentic client for the Aura ecosystem.**

A quiet conversation with memory, a chosen agent, and a verification state you can
trust — over the engineering intelligence of [`aura-code`](https://www.npmjs.com/package/aura-code).

```
· Fixer  ·  qwen2.5-coder:1.5b (local)  ·  verified
› the pagination helper drops the last page — fix it
```

---

## Install

```bash
npm install -g aura-op-one
opone
```

Needs at least one provider key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`GOOGLE_API_KEY`, `XIAOMI_API_KEY`, `ZHIPU_API_KEY`) or a local Ollama model.
Credentials are read through `aura-code` — Aura OP One stores no secrets of its own.

## Use

```bash
opone                                  # start a conversation
opone --root ~/code/my-project         # work in a specific project
opone --readonly                       # no writes, no shell
opone --test-command "npm test"        # give the verification gate a test suite
opone --resume <conversation-id>       # pick up where you left off
```

The default screen shows **only** the conversation, the active agent, the active
model, and the verification state. Everything else is behind a `:` command:

| Command | |
|---|---|
| `:agent` | list agents · `:agent <id>` to switch · `:agent new` to create one |
| `:model` | show the active model · `:model <id>` to override · `:model auto` to clear |
| `:council` | `:council security,performance ? should we cache tokens` |
| `:mesh` | mesh state · `:mesh on\|off` · `:mesh run <task>` (off by default) |
| `:verify` | verify the last output |
| `:memory` | `:memory <query>` — see what would be retrieved, and why |
| `:status` | session state and last-turn timings |
| `:help` | the list |

No graphs, dashboards, telemetry, or routing internals. That surface belongs to
aura-pulse.

---

## What it does

The canonical loop, once per message:

```
request → retrieve experience → select agent/model → act
        → verify → record episode → improve future routing
```

- **Persistent conversations** and **personal preferences**, stored separately.
- **Engineering-experience retrieval** — verified experience outranks unverified
  chat by a dominating tier, so no amount of keyword overlap floats a guess above
  evidence. Every retrieved item keeps its source, time, confidence, verification
  state and project.
- **Local or cloud models**, chosen per agent policy through `aura-code`'s
  Archimedes competence tracking. A local model that is down falls back to cloud,
  says so, and records it.
- **Manually created agents** — id, purpose, instruction, permitted tools, model
  policy, verification policy, memory scope. Schema-validated, inspectable JSON.
- **Councils** — one question, roles you name, agreements and disagreements, one
  synthesis, verified and recorded.
- **Verification you can trust** (see below).
- **Optional Agent Mesh** for delegated execution — disabled by default.

## Verification

Five explicit states. There is no implicit sixth:

| | |
|---|---|
| `unverified` | produced, not submitted to the gate — the default |
| `verification_pending` | gate running |
| `verified` | the gate **approved** |
| `rejected` | the gate declined |
| `escalated` | inconclusive — needs a human |

`verified` is reachable **only** from `verification_pending`, and only on an
approval. A gate that throws yields `escalated`, never a pass. The UI renders the
stored state and never infers one.

For code changes the record keeps the verifier's decision, the evidence examined,
the tests executed, the files changed, and the commit SHA.

**Verification is not permission.** A verified change still needs your explicit
approval to commit. There is no auto-commit path.

## Safety

- Credentials come from `aura-code`; this client adds no second keychain.
- Everything bound for a store, a log, or the screen passes secret redaction first.
- Filesystem, shell, network and Git actions go through `aura-code`'s permission
  system. Councils and mesh agents use the same one — there is no elevated path.
- External content — web fetches, mesh results, council output — is treated as
  untrusted input: evidence to verify, never instructions to follow.

## Storage

Six separate categories under `~/.aura/op-one/`:

```
conversations/   preferences.json   agents/   knowledge/   episodes/
```

plus in-memory scratch. They stay separate on purpose — that separation is what
makes an agent's memory scope enforceable. `knowledge/` accepts **verified items
only**.

Override the root with `AURA_OP_ONE_DIR` (always set it in tests).

---

## Ecosystem

| | |
|---|---|
| [`aura-code`](https://github.com/milodule3-debug/aura-code) | the engineering intelligence engine |
| **Aura OP One** | the minimal personal and agentic client |
| Agent Mesh | optional multi-agent execution |
| aura-pulse | observability and control |
| aura-50-day-trial | public verification laboratory |

**This is a client, not a second engine.** Execution, tools, providers, the
verification gate, permissions and credentials all stay in `aura-code`, reached
across a single interface. `src/engine.ts` is the only file that imports it.

## Develop

```bash
npm install
npm run build
npm test                    # 172 tests, no provider or network required
node dist/cli.js --help
```

The whole client runs its suite against a fake engine (`tests/fake-engine.ts`).
That it can is the evidence the boundary holds — nothing reaches around it.

If you need a new `aura-code` capability, **add a method to `Engine` and implement
it in `src/engine.ts`.** Do not import across the boundary from anywhere else.

Full design, boundaries and deferred scope: [`AURA_OP_ONE_ARCHITECTURE.md`](AURA_OP_ONE_ARCHITECTURE.md).

## License

MIT
