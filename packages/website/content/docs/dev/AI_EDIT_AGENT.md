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
  └─ edit ─► attachment brief? ─► precise Agent ─► plan/steps ─► local summary
                         │                    │
                         │                    ├─ progressive apply ► completed/partial
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

When the global AI context mode is `summary`, the main process deliberately
ignores historical messages and sends at most one bounded, document-scoped
rolling summary. The current task, full raw Markdown snapshot, and current
attachments are still sent normally, and every mode receives its complete
system prompt again. Historical images, PDFs, reasoning, status messages, and
Agent tool transcripts are not replayed in this mode. The full chat remains
available for renderer display.

The renderer then records `sending`, `sent`, and `waiting` progress. The main
process emits provider and Agent progress through `mt::ai::progress` while the
request is running.

## Main-process edit state machine

The precise Agent is implemented by `runDocumentEditAgent()`.

```text
No plan
  │ create_markdown_edit_plan
  ├─ valid ─────────────────────► Planned
  └─ invalid ─► validation failure ─► create-only retry

Planned
  │ append_markdown / prepend_markdown / apply_markdown_edit
  ├─ valid ─────────────────────► Step applied ─► Planned
  ├─ location/scope failures ──► Plan revision required ─► revise-only turn
  └─ invalid tool/arguments etc. ► validation failure ─► retry

Plan revision required
  │ revise_markdown_edit_plan
  ├─ valid ─────────────────────► Planned with remaining steps
  └─ invalid ───────────────────► validation failure ─► retry

Planned with all steps complete
  │ host builds a local summary
  └────────────────────────────► Agent complete
```

The main process owns this state machine and exposes exactly one editing tool
per provider turn: create while no plan exists, append/prepend for insertion
steps, apply for replacement steps, and revise when the plan needs repair.
There is no completion model call after the last step; the host creates the
final summary.
The current document version and active plan-step ID are host-owned fields and
are not requested from the model. Each turn is rebuilt from a compact
checkpoint containing the task, current Markdown, plan state, completed steps,
and the latest validation error; prior Agent tool calls, results, and reasoning
are not replayed. This keeps one Agent request bounded by the current document
and plan rather than by every prior step.

### Plan creation

The model must create exactly one plan before applying an edit. Each plan step
has an ID, description, intent, `startAnchor`, optional `endAnchor`, and
dependencies. The host owns the current document version and does not ask the
model to repeat it.

The initial plan is checked against the current document immediately. Steps are
organized by edit location rather than semantic topic; adjacent insertions are
one `append` or `prepend` step. A plan is capped at 16 steps.

Each step declares `operation: append | prepend | replace`:

- `append` and `prepend` return only new Markdown. The host owns paragraph
  separators and never simulates insertion by replacing the last line.
- `replace` is the only operation that uses anchors and exact SEARCH/REPLACE.

The anchor rules are:

- A non-empty document requires a valid `startAnchor` for the first
  replacement step. Append and prepend steps do not use anchors.
- An empty document's first replacement step uses `startAnchor: ''` and omits
  `endAnchor`; append and prepend steps still omit anchors. Its replacement
  uses the empty `SEARCH` insertion path.
- Later dependent steps may use an empty `startAnchor` when their target will
  be created by an earlier step. Before that step becomes active, the host
  requires a revised plan with a current anchor.

The main process emits `agent-plan` after a plan is accepted. Plan revisions
also emit `agent-plan`, with `planRevisionCount` and `successfulSteps` showing
that the remaining plan changed rather than starting a new request.

### Incremental step application

Only the first unfinished plan step may be applied. Each replacement
`apply_markdown_edit` call must:

- target the host-selected first unfinished plan step;
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

Two invalid initial plans trigger the existing complete-document fallback. The
fallback is validated and returned for user confirmation; it is never applied
silently. After progressive steps have been applied, repeated revision
failures terminate the request while preserving those successful steps.

### Completion and limits

The result carries the final Markdown, edit summary, recovery metadata, and a
host-generated summary. The Agent also enforces bounded successful steps,
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
                     ├─ compacting → responded
                     ├─ agent-plan → agent-step → validating …
                     ├─ attempt-failed → retrying → validating …
                     ├─ fallback → validating …
                     └─ responded → local-processing → completed/partial

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

In summary mode, `compacting` represents one short, non-streaming call using
the selected model. Its output is returned as a candidate memory value and is
committed only after an answer is saved or an edit/rewrite is successfully
applied. Empty or failed compaction falls back to a bounded local summary and
never turns an otherwise successful request into a failure. Cancelled, stale,
failed, and discarded recovery results keep the previous memory.

When the request has current images or PDF pages, the main process first makes
one `attachment-extracting` call containing only the task and those images.
The resulting bounded Markdown `sourceBrief` is used by every Agent checkpoint;
the pages are not resent on later turns. Extraction retries once on empty,
reasoning-only, or truncated output and aborts before any document change if it
still fails.

Native Agent calls use a named tool choice, strict schemas, and
`parallel_tool_calls: false` when supported. Only a 400/404/422 error that
explicitly identifies tools, `tool_choice`, strict/function schemas, or
`parallel_tool_calls` can trigger a downgrade to a non-strict native request
and then to a JSON envelope. Parameter errors unrelated to the tool transport
are returned once. A successful HTTP response with a missing or truncated tool
call stays on the current transport; it is retried by the Agent state machine
and never poisons the transport cache. The JSON fallback accepts only a
complete JSON object and never extracts fragments from prose or fences. A
transport is cached only after an explicit protocol rejection and a usable
fallback response.

Model request JSON presets are user-authored and are applied after the
application constructs the protocol body. The normal model/session preset is
used by answer and rewrite requests. The model's optional edit-Agent preset
independently controls attachment extraction, planning, revisions, edit steps,
and whole-document fallback; omitted means inherit, `null` means no extra JSON,
and a string selects a named preset. Hidden context summaries never apply a
preset.

Agent checkpoint logs use the `[ai-editor]` prefix and record only phase,
transport, allowed tool, document version, plan/step counts, checkpoint and
source-brief sizes, plan-fingerprint size, attachment page count, token usage,
validation category, state transition, and fallback/partial reason. They never
include Markdown, attachment bytes, attachment paths, API keys, or reasoning
content.

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

If a provider, network, cancellation, or later validation failure arrives after
one or more successful steps, the renderer verifies that the raw document still
equals the last confirmed step snapshot, records one base-to-current change in
the AI change tracker, and emits terminal `partial`. The summary candidate is
not committed. The UI reports the completed/total plan steps and the retained
change remains available to AI undo. If no step succeeded, the request remains
eligible for the confirmation-only whole-document fallback.

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
- `partial` is terminal: at least one precise step was committed, later work
  stopped, the retained changes are undoable, and no whole-document overwrite
  was attempted.
- A chat persistence error is not an AI request failure. It must not overwrite
  a successful document result with `failed`.
- A stale document result is never applied. The request is cancelled or
  discarded, and the editor unlocks only after the request/apply work settles.

When changing this flow, update the shared progress types, renderer persistence
ordering, and the relevant tests together. The primary regression suites are
`packages/desktop/test/unit/specs/ai-document-edit-agent.spec.ts`,
`ai-connections.spec.ts`, and the AI renderer/store specs.
