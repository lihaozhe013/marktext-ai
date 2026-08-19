# AI Edit Agent Flow and State Machine

This document describes the fork-owned AI editor flow for `answer`, `edit`,
and `rewrite` requests. It is intended for contributors changing the Agent,
the AI panel, editor-tab coordination, progress persistence, or AI revisions.

The implementation is split across these areas:

- `packages/desktop/src/main/ai/index.ts` owns provider requests, progress
  events, chat/revision persistence, and the main-process edit transaction.
- `packages/desktop/src/main/ai/documentEditAgent.ts` owns precise edit plans,
  tool validation, incremental Agent steps, retries, and final summaries.
- `packages/desktop/src/renderer/src/store/ai.ts` owns the request session,
  editor lock, progress/chat ordering, step application, recovery, and undo.
- `packages/desktop/src/shared/types/ai.ts` defines request, response, progress,
  chat, and revision contracts.
- `packages/desktop/src/renderer/src/components/aiPanel/index.vue` renders live
  progress and persisted status messages.

The AI Edit Transaction Contract in the repository's root `CLAUDE.md` contains
the invariants for raw Markdown snapshots, stale-result handling, revision
journaling, and editor locking. This document explains the runtime sequence
around those invariants.

## High-level request flow

Every request follows the same outer lifecycle:

```text
idle
  │
  ├─ answer ───────────────────────────────► provider response ► assistant answer ► completed
  │
  ├─ rewrite ──────────────────────────────► Markdown repair ► transactional apply ► completed
  │
  └─ edit ─► precise Agent ─► plan/steps ─► final summary
                         │                    │
                         │                    ├─ progressive apply ► completed
                         │                    └─ recovery proposal ► confirmation
                         │
                         └─ validation/provider/cancel failure ► failed or cancelled
```

Before an `edit` or `rewrite` request starts, the renderer:

1. Flushes the active editor surface.
2. Captures the raw Markdown, document identity, tab identity, active surface,
   and content revision.
3. Starts an AI edit session and locks document mutations, tab switching, and
   editor-surface changes until the request settles.
4. Adds the user message and queues its chat persistence.
5. Sends only usable conversation messages to the main process. Persisted
   `kind: status` progress messages are deliberately excluded from model
   context.

The renderer then records `sending`, `sent`, and `waiting` progress. The main
process emits provider and Agent progress through `mt::ai::progress` while the
request is running.

## Main-process edit state machine

The precise Agent is implemented by `runDocumentEditAgent()`.

```text
No plan
  │ create_markdown_edit_plan
  ├─ valid ─────────────────────► Planned
  └─ invalid ─► validation failure ─► retry

Planned
  │ apply_markdown_edit for first unfinished step
  ├─ valid ─────────────────────► Step applied ─► Planned
  ├─ location/scope failures ──► Plan revision required
  └─ invalid tool/version/etc. ► validation failure ─► retry

Plan revision required
  │ revise_markdown_edit_plan
  ├─ valid ─────────────────────► Planned with remaining steps
  └─ invalid ───────────────────► validation failure ─► retry

Planned with all steps complete
  │ finish_markdown_edit(non-empty summary)
  └────────────────────────────► Agent complete
```

### Plan creation

The model must create exactly one plan before applying an edit. Each plan step
has an ID, description, intent, `startAnchor`, optional `endAnchor`, and
dependencies. Plan versions must match the current document version.

The initial plan is checked against the current document immediately:

- A non-empty document requires a valid `startAnchor` for the first step.
- An empty document requires the first step to use `startAnchor: ''` and to
  omit `endAnchor`. Its edit uses the empty `SEARCH` insertion path.
- Later steps are allowed to reference text created by earlier steps. Their
  anchors are checked when that step is applied, not when the initial plan is
  created.

The main process emits `agent-plan` after a plan is accepted. Plan revisions
also emit `agent-plan`, with `planRevisionCount` and `successfulSteps` showing
that the remaining plan changed rather than starting a new request.

### Incremental step application

Only the first unfinished plan step may be applied. Each
`apply_markdown_edit` call must:

- use the current document `version`;
- name an unfinished `planStepId`;
- provide exact string `search` and `replace` values;
- match exactly once in the current Markdown;
- remain within the step's anchor scope; and
- pass Markdown compatibility checks.

After validation, the main process updates its working Markdown and version,
marks the plan step complete, and emits `agent-step` with the before/after
snapshots and a bounded diff. The renderer applies that snapshot immediately
to the active editor surface. This is why a progressive request can visibly
change the document before the final Agent response arrives.

The Agent tracks location failures separately. Repeated anchor, scope, or
match failures require `revise_markdown_edit_plan`; the model must not keep
applying edits against a stale plan. Completed steps are immutable and cannot
be returned in a revised plan.

### Completion and limits

The model can call `finish_markdown_edit` only when:

- the requested version equals the current version;
- a plan exists;
- every plan step is complete; and
- the summary is a non-empty, concise string.

The result carries the final Markdown, edit summary, recovery metadata, and
the model's summary message. The Agent also enforces bounded successful steps,
invalid turns, plan revisions, and total runtime. These limits are safety
boundaries, not additional model retries.

## Progress state and persistence

There are two progress representations:

1. `AiProgressEvent` is transient live progress sent over IPC. It drives the
   current request indicator and incremental step application.
2. `AiProgressInfo` is a persisted status message in chat history. It is used
   to render the request after reload and is not sent back to the model.

The relevant phases are:

```text
waiting → streaming → validating
                     ├─ agent-plan → agent-step → validating …
                     ├─ attempt-failed → retrying → validating …
                     ├─ fallback → validating …
                     └─ responded → local-processing → completed

Any active request may end in failed or cancelled.
```

For an edit request, persisted progress is serialized in this order:

```text
user → agent-plan → agent-step(s) → responded → local-processing
     → assistant summary → completed
```

The renderer has a progress persistence queue and a separate chat persistence
queue. Before adding `responded`, it waits for the plan and step events already
received by the renderer to be persisted. The final assistant summary is
queued before `completed`.

Chat writes are also serialized in the main process because each write is a
read-modify-write of `ai-chat.json`. A persistence failure is logged with the
`[ai-editor]` prefix and does not turn an already applied document edit into a
request failure. IPC payloads must contain plain cloneable data; in particular,
Vue reactive proxies must not cross the renderer/main boundary.

## Renderer application states

The renderer's AI edit session and the Agent's main-process state are related
but not interchangeable:

| Renderer state | Meaning |
| --- | --- |
| `running` | The request is active and the document is locked. |
| `applying` | A validated Agent step or transactional result is being applied. |
| `awaiting-confirmation` | A complete-document fallback or stale recovery result waits for user approval. |
| `stale` | The document, tab, identity, revision, or expected step snapshot no longer matches. |
| ended | The request has settled and the editor lock is released. |

On `agent-step`, the renderer verifies the request ID, document ID, tab ID,
active surface, and expected base Markdown. If any check fails, it marks the
session stale and cancels the main-process request. A successful step is added
to the progressive-request set, so the final response does not replay the
entire document.

### Progressive edit completion

When at least one Agent step was applied successfully:

1. The renderer waits for the final main-process response.
2. It records the accumulated change range in the AI change tracker.
3. It appends the final assistant summary. If an unexpected empty summary
   reaches the renderer, a local summary is generated as a safety fallback.
4. It queues `completed` after the summary.
5. It unlocks the editor in the request cleanup path.

The final response must not call the normal full-document revision apply path,
because that would replay already applied steps and could overwrite user
changes. The progressive path is not silently rolled back when a later Agent
turn fails; successful steps remain visible and can be undone through the AI
revision mechanism.

### Transactional edit and recovery

If no Agent step was applied, `applyEdit()` uses the revision journal:

1. Prepare a revision from the exact raw snapshot to the proposed Markdown.
2. Re-check the session and active document before applying.
3. Apply to exactly one active editor surface.
4. Commit the revision only after the editor confirms the result.
5. Persist the assistant summary and change metadata.

Complete-document fallback results are never applied silently. They enter
`awaiting-confirmation`; accepting uses the same guarded apply path, while
discarding removes the prepared revision and unlocks the editor.

## Failure and cancellation semantics

- `attempt-failed`, `retrying`, and `fallback` are non-terminal progress. They
  describe model or validation recovery inside the same request.
- `failed` is terminal and represents provider failure, invalid tool output,
  exhausted Agent limits, stale application failure, or another request error.
- `cancelled` is terminal and is emitted when the user stops an active request
  or the main process observes cancellation.
- A chat persistence error is not an AI request failure. It must not overwrite
  a successful document result with `failed`.
- A stale document result is never applied. The request is cancelled or
  discarded, and the editor unlocks only after the request/apply work settles.

When changing this flow, update the shared progress types, renderer persistence
ordering, and the relevant tests together. The primary regression suites are
`packages/desktop/test/unit/specs/ai-document-edit-agent.spec.ts`,
`ai-connections.spec.ts`, and the AI renderer/store specs.
