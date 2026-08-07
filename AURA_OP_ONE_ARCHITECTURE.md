# Aura OP One — Architecture

> Status: MVP, implemented in this repository (`aura-op-one`).
> Canonical loop: **Request → retrieve experience → select agent/model → act → verify → record episode → improve future routing**

---

## 1. Product purpose

Aura OP One is the **minimal personal and agentic client** for the Aura ecosystem.

It gives a single calm surface — a conversation, an active agent, an active model, a
verification state — over the full depth of `aura-code`'s engineering intelligence:
memory, verification, councils, local/cloud model alternation, and optional
multi-agent execution.

The design constraint is subtractive. Aura OP One is *not* a dashboard, not a second
orchestration engine, not a second verification system. Everything it does that is
hard is delegated across a narrow boundary to `aura-code`. What Aura OP One owns is
the **experience**: what the user sees, what is remembered about them, which agent
acts, and whether the result may be called verified.

---

## 2. Responsibilities owned by Aura OP One

| Responsibility | Detail |
|---|---|
| Conversation surface | Minimal terminal chat; conversation, active agent, active model, verification state, `:` commands |
| Conversation persistence | Its own store, independent of `aura-code` sessions |
| Personal preferences | User-level, cross-project, explicitly *not* engineering knowledge |
| Agent definitions | Manually created, schema-validated, inspectable JSON |
| Experience retrieval | Ranked recall across separated memory categories, provenance preserved |
| Routing intent | Which agent, which model policy, whether a council or the mesh is invoked |
| Verification state | The lifecycle (`unverified → … → verified`/`rejected`/`escalated`) and its display |
| Episode recording | Provenance-carrying records of what happened and what the verifier decided |
| Approval gates | Asking the user before consequential actions, including every commit |

## 3. Responsibilities retained by aura-code

| Responsibility | Interface used |
|---|---|
| Agent execution loop | `runAgentLoop(LoopOptions): LoopResult` |
| Tool implementations | `src/tools/` — reached only through the loop, never called directly |
| Provider/model abstraction | `createProvider(ProviderConfig): LLMProvider` |
| Local/cloud alternation | `ArchimedesAlternator`, `assessCompetence` |
| Verification gate | `verifyTask(CheckContext, VerificationConfig): VerificationResult` |
| Permission enforcement | `PermissionSystem.check(tool, input)` |
| Credential storage | `getApiKeyForModel(model)` — env/global config, never re-implemented here |
| Council panel execution | `runCouncil(...)` |
| Episode persistence (engineering) | `episodeStore` under `~/.aura/episodes/` |

**Rule:** Aura OP One never reimplements any row of this table. If a capability is
missing, it is added to `aura-code` and consumed across the boundary.

### The boundary itself

One seam, declared in `src/engine.ts`:

```ts
interface Engine {
  run(req: EngineRunRequest): Promise<EngineRunResult>;   // → runAgentLoop
  verify(req: EngineVerifyRequest): Promise<VerificationResult>; // → verifyTask
  recordEpisode(projectRoot: string, ep: Episode): Promise<void>; // → episodeStore
  checkPermission(tool: string, input: Record<string, unknown>): PermissionOutcome;
  resolveModel(policy: ModelPolicy): Promise<ResolvedModel>;
}
```

Everything in `src/` depends on this interface, not on `aura-code` internals.
The production implementation (`createAuraCodeEngine`) is the only file that imports
from `../agent/`, `../verify/`, `../archimedes/`, `../safety/`, `../providers/`.
Tests substitute a fake engine. This is what makes the client thin and what will make
extraction into a standalone `aura-op-one` repository mechanical rather than a rewrite
(see §12).

---

## 4. Boundary with Agent Mesh

Agent Mesh is an **optional delegated-execution layer**. It is **disabled by default**.

It may run only when the user explicitly requests it (`:mesh on`, `:mesh run <task>`)
or when a **visible, configurable routing rule** in preferences matches.

| Aura OP One retains | Agent Mesh provides |
|---|---|
| User intent interpretation | Parallel/delegated execution of a defined sub-task |
| Experience retrieval | Structured results |
| **Permission checks** | — |
| **Verification** | Evidence (tool calls, files, tests) fed back for verification |
| Final synthesis | — |
| Episode recording | — |

Mesh agents execute through the *same* `Engine.run` path and therefore the *same*
`PermissionSystem`. A mesh result arrives as `unverified` evidence and must pass the
same verification gate as local work. **There is no mesh code path that can produce a
`verified` state without the gate, and none that can touch the filesystem, shell,
network or Git without a permission check.** If the mesh transport fails, the task
falls back to local single-agent execution and the fallback is recorded in the episode.

## 5. Boundary with aura-pulse

`aura-pulse` is the observability and control surface. Aura OP One **does not**
render graphs, telemetry, dashboards, or fleet state, and does not replace Pulse.

Aura OP One *emits* — episodes with provenance, verification outcomes, model/token
counters — into the stores Pulse already reads (`~/.aura/episodes/`, plus its own
`~/.aura/op-one/`). Consumption and visualisation belong to Pulse. `:status` shows a
few lines of local session state, not a monitoring view.

---

## 6. Conversation and execution flow

```
   user message
        │
        ▼
 ┌─────────────────┐
 │ 1. Request      │  captured into conversation store
 └────────┬────────┘
          ▼
 ┌─────────────────┐
 │ 2. Retrieve     │  memory.retrieve() across the 6 categories
 │    experience   │  verified engineering knowledge ranked above chat
 └────────┬────────┘
          ▼
 ┌─────────────────┐
 │ 3. Select agent │  active agent (or :agent choice) → its model policy
 │    and model    │  Engine.resolveModel() → local (Archimedes) or cloud
 └────────┬────────┘
          ▼
 ┌─────────────────┐
 │ 4. Act          │  Engine.run() → aura-code loop, permissions enforced
 │                 │  optionally delegated to Agent Mesh, or a council
 └────────┬────────┘
          ▼
 ┌─────────────────┐
 │ 5. Verify       │  state → verification_pending
 │                 │  Engine.verify() consumes tool-call evidence
 │                 │  → verified | rejected | escalated
 └────────┬────────┘
          ▼
 ┌─────────────────┐
 │ 6. Record       │  episode + provenance; commit only after user approval
 │    episode      │
 └────────┬────────┘
          ▼
 ┌─────────────────┐
 │ 7. Improve      │  verified outcomes promoted to reusable knowledge;
 │    routing      │  competence feeds the next model selection
 └─────────────────┘
```

---

## 7. Storage ownership

Six **separate** categories. Nothing is merged into one undifferentiated store.

| # | Category | Owner | Location | Lifetime |
|---|---|---|---|---|
| 1 | Conversation history | OP One | `~/.aura/op-one/conversations/` | Until deleted |
| 2 | Personal preferences | OP One | `~/.aura/op-one/preferences.json` | Durable, user-level |
| 3 | Engineering episodes | aura-code (`episodeStore`) + OP One provenance index | `~/.aura/episodes/`, `~/.aura/op-one/episodes/` | Durable |
| 4 | Verified reusable knowledge | OP One | `~/.aura/op-one/knowledge/` | Durable; **only** written after a `verified` outcome |
| 5 | Agent definitions | OP One | `~/.aura/op-one/agents/` | Durable |
| 6 | Temporary execution context | OP One | in-memory only | Single turn |

Every retrievable record carries provenance and it is never dropped on retrieval:

```ts
interface Provenance {
  source: string;              // where it came from
  createdAt: string;           // ISO-8601
  confidence: number;          // 0..1
  verification: VerificationState;
  agentId?: string;
  projectRoot?: string;
}
```

**Ranking rule:** `verified` engineering knowledge outranks `unverified` conversation
content, always — regardless of recency or textual match score.

---

## 8. Permission and credential boundaries

- Credentials are **read** through `aura-code`'s existing resolution
  (`getApiKeyForModel`, env vars, global config). Aura OP One stores no secrets and
  adds no second keychain.
- Every value leaving the process toward a log, a store, or the UI passes
  `redactSecrets()`. API keys, bearer tokens, and `*_API_KEY`-shaped values are
  replaced with `[redacted]`.
- Filesystem, shell, network and Git actions are permission-checked by
  `PermissionSystem`. Councils and mesh agents use the **same instance** — there is no
  elevated path.
- **No automatic commits.** Commits require explicit user approval in the client, and
  verification passing is *not* a substitute for that approval.
- Consequential actions (commit, push, destructive shell) prompt.
- Verified actions leave an audit trail in the episode record: verifier decision,
  evidence examined, tests executed, files changed, commit SHA when applicable.
- All external content (web fetch, mesh results, council panel output) is treated as
  **untrusted input** — it becomes evidence to verify, never instructions to follow.

## 9. Local/cloud model behavior

Model choice is a **policy**, not a hardcoded id. Each agent declares one:

- `local-first` — try Archimedes (local Ollama) when competence for the task pattern
  clears the threshold; escalate to cloud otherwise.
- `cloud-only` — always the configured cloud model.
- `local-only` — local model; fails closed rather than silently spending cloud tokens.
- `{ model: "<id>" }` — pinned.

Resolution goes through `Engine.resolveModel`, which defers to `aura-code`'s
Archimedes alternator and competence tracking. `:model` overrides for the session and
shows what actually resolved — the client never claims "local" when it ran cloud.

**Local-model failure fallback:** if the local model is unreachable or errors,
resolution falls back to the configured cloud model, the user is told, and the
fallback is recorded in the episode. `local-only` is the exception: it reports failure
instead of falling back.

## 10. Verification behavior

Explicit states, no implicit ones:

| State | Meaning |
|---|---|
| `unverified` | Produced, not yet submitted to the gate. The default. |
| `verification_pending` | Submitted; gate running. |
| `verified` | The gate **approved**. Only reachable from `verification_pending`. |
| `rejected` | The gate declined. Output retained, not promoted to knowledge. |
| `escalated` | Gate inconclusive or retries exhausted — needs a human. |

Legal transitions (enforced in code, `src/verification.ts`):

```
unverified          → verification_pending
verification_pending → verified | rejected | escalated
rejected            → verification_pending      (after a fix)
escalated           → verification_pending | rejected
verified            → (terminal)
```

The UI renders **exactly** the stored state. `verified` is never displayed for output
the gate did not approve, and never inferred from "the command exited 0".

For code changes the record includes: verifier decision, evidence examined, tests
executed, files changed, and commit SHA when a commit happened.

Verification is not permission. A `verified` change still requires user approval to
commit.

## 11. Failure and fallback behavior

| Failure | Behaviour |
|---|---|
| Local model unreachable | Fall back to cloud, tell the user, record in episode (`local-only` reports failure instead) |
| Cloud provider error | `aura-code` resilient factory: retry → fallback chain → circuit breaker |
| Verification gate throws | State becomes `escalated`, never `verified` |
| Verification fails | `rejected`; output shown as rejected, not promoted to knowledge |
| Agent Mesh unavailable/errors | Fall back to local single-agent execution, tell the user, record the fallback |
| Council panel seat fails | Synthesis proceeds with the seats that answered; failures counted and reported |
| Store write fails | Turn continues; failure surfaced rather than silently swallowed |
| Permission denied | Action does not happen; the denial is reported, not routed around |

---

## 12. MVP scope

Implemented:

1. Minimal chat/terminal interface (conversation, active agent, active model, verification state, `:` help)
2. Connection to the `aura-code` engine through the single `Engine` seam
3. Persistent conversations
4. Persistent personal preferences
5. Engineering-experience retrieval with provenance
6. Local/cloud model selection via Archimedes competence
7. Manual agent creation and selection
8. Council invocation (defined question, explicit roles, agreements/disagreements, one synthesis, verified, recorded)
9. Verification of important outputs
10. Verification before commits
11. Episode recording with provenance
12. Optional Agent Mesh execution, disabled by default

Commands: `:agent`, `:model`, `:council`, `:mesh`, `:verify`, `:memory`, `:status`, `:help`.

**Invocation.** The shell command is **`opone`**. This is deliberately *not* `aura-op-one`
and deliberately not prefixed `aura`: the client sits beside `aura` in the same `PATH`,
and a name that only differs by a suffix invites typing the wrong one — the two have
different permission postures, so picking the wrong binary is not a harmless mistake.
The product name, repository and package/application id all remain `aura-op-one`; only
the binary is short. Run it as `opone` (see the README quickstart).

**Repository placement.** This is a standalone repository and a standalone product.
It does **not** vendor `aura-code` and does not modify it: `aura-code` is an ordinary
npm dependency (`^0.14.0`), and `src/engine.ts` reaches it through its published
`dist/`, which ships type declarations. That is what keeps "no duplication" true in
the literal sense — there is exactly one copy of the engine, in its own package.

The extraction was mechanical, as the seam promised. Every cross-boundary import in
the client — all twelve — lived in `engine.ts`; moving the code out was a path
rewrite in that one file, with no other source change and no test change. The suite
passed identically before and after.

The deep imports (`aura-code/dist/agent/loop.js`) are the one seam-level compromise:
`aura-code` publishes no `exports` map, so the client reaches into its `dist/` by
path. §14 lists what should be formalized to remove that.

## 13. Explicitly deferred

Not implemented, deliberately: autonomous agent generation · large graphical dashboard ·
any aura-pulse replacement · mobile application · voice or avatar system · marketplace ·
background autonomous operation · automatic fine-tuning · a new vector database ·
a second verification system · a second orchestration engine · social/collaboration platform.

## 14. aura-code interfaces that should be formalized

These are consumed across the boundary and are currently internal. They should become
a stable, versioned, exported surface before `aura-op-one` is extracted:

1. `runAgentLoop(LoopOptions): LoopResult` — the execution contract. `LoopOptions` is
   wide (25+ fields, several CLI-shaped); a narrowed `ExecuteRequest` would be a better
   public contract.
2. `verifyTask(CheckContext, VerificationConfig)` — `CheckContext` requires
   `filesBefore` captured by the caller before execution; that pre/post protocol should
   be part of the published interface, not folklore.
3. `Check` — carries `{ name, passed, detail }`. It has no machine-readable evidence
   kind, so "which tests ran" has to be re-derived from tool calls. Adding an
   `evidence` field would let verification records be structured rather than parsed.
4. `PermissionSystem.check` — needs a non-interactive/programmatic mode contract for
   delegated (mesh, council) execution.
5. `Episode` — Archimedes-shaped (`archimedesAttempted`, `largeModelUsed`). A generic
   provenance envelope would avoid OP One keeping a parallel record.
6. `createProvider` / model resolution — `resolveModel` should be first-class rather
   than assembled from `createProvider` + alternator + competence by each caller.
7. `Display` — 20+ methods, terminal-shaped; a minimal `EventSink` would let non-TUI
   clients consume the loop without stubbing.
8. **An `exports` map.** `aura-code` declares none, so this client imports by path
   into its `dist/` (`aura-code/dist/agent/loop.js`). That works and is fully typed —
   the package ships `.d.ts` — but it depends on an internal layout no semver promise
   covers, so a reorganisation inside `aura-code` breaks this client without a major
   version bump to signal it. An `exports` map naming the seven entries above would
   turn today's reach-in into a supported contract. **This is the highest-value item
   on the list**: the others improve the interface, this one makes it safe to depend
   on at all.

---

## 15. Acceptance scenario

The end-to-end path exercised by `tests/op-one/e2e-acceptance.test.ts`:

1. User asks Aura OP One to improve a small project.
2. Relevant **verified** experience is retrieved and ranked above chat history.
3. An agent is selected.
4. A local or cloud model is selected through `aura-code`.
5. The agent performs the task under normal permissions.
6. Verification evaluates the result **and its tool evidence**.
7. The client displays the resulting state.
8. The user approves or rejects the commit.
9. Episode and verification outcome are recorded with provenance.
10. A later related request retrieves that experience, provenance intact.
