# Contract: host ⇄ webview debug protocol changes

**Feature**: `specs/003-cooperative-threads`

Changes to `src/webviewProtocol.ts`. Per constitution principle III every message stays part of the
discriminated union and every new field is validated by a type guard before it is read.

## Host → webview (`DebugHostToPanelMessage`, `webviewProtocol.ts:17-29`)

| Type | Change | New payload |
|---|---|---|
| `dbg:continue` | unchanged | — |
| `dbg:next` | **+ `threadId: number`** | which thread to advance (FR-034) |
| `dbg:stepIn` | **+ `threadId: number`** | " |
| `dbg:stepOut` | **+ `threadId: number`** | " |
| `dbg:pause` | unchanged | stop-the-world (research R10) |
| `dbg:stackTrace` | **+ `threadId: number`** | `{requestId, threadId}` |
| `dbg:scopes` | unchanged | `frameId` already encodes the thread (data-model §6) |
| `dbg:variables` | unchanged | `variablesReference` already encodes the thread |
| `dbg:evaluate` | unchanged | `frameId` already encodes the thread |
| `dbg:threads` | **new** | `{requestId}` — ask the webview for the live thread list |
| `dbg:launch`, `dbg:setBreakpoints`, `dbg:disconnect` | unchanged | breakpoints stay per source line, not per thread |

## Webview → host (`DebugPanelToHostMessage`, `webviewProtocol.ts:40-47`)

| Type | Change | New payload |
|---|---|---|
| `dbg:stopped` | **+ `threadId: number`** | which thread hit the breakpoint/error |
| `dbg:stackTrace` | **+ `threadId: number`** | echoed back so the host can validate the correlation |
| `dbg:threads` | **new** | `{requestId, threads: Array<{id: number, name: string, status: string}>}` |
| `dbg:threadStarted` | **new** | `{threadId, name}` → host emits a DAP `thread` event, `reason: 'started'` |
| `dbg:threadExited` | **new** | `{threadId}` → host emits `reason: 'exited'` |
| `dbg:output` | **+ `threadId?: number`** | optional attribution for `schreib` output |
| `dbg:terminated`, `dbg:scopes`, `dbg:variables`, `dbg:evaluate` | unchanged | `dbg:terminated` still means the **whole program** ended, never one thread |

## Type guards (`webviewProtocol.ts:69-100`)

`isPanelToHostMessage` gains a case per new type and a `threadId` check on the changed ones.
Current `dbg:stopped` validation (`:81-82`) only checks `reason`; it must also accept
`threadId: number`. Existing coverage in `test/webviewProtocol.test.cjs` (78 lines) extends with
accept/reject cases for each.

`isDebugMessage` (`:64-66`) needs no change — the `dbg:` prefix check already admits the new types.
But note `hamsterPanel.ts:144-151` drops anything failing `isPanelToHostMessage`, so a new type
added to the union without a guard case is **silently discarded**.

## DAP surface (`src/hamsterDebugSession.ts`)

| Request/event | Change |
|---|---|
| `threads` (`:200-202`) | Replace the hard-coded `[{id: 1, name: 'Hamster'}]` with a `dbg:threads` round trip |
| `stopped` (`:138-145`) | `threadId: msg.threadId` instead of literal `1`; `allThreadsStopped: true` stays and is now *true by construction* |
| `thread` event | **new** — emitted on `dbg:threadStarted` / `dbg:threadExited` |
| `stackTrace` (`:437-452`) | Read `request.arguments.threadId` and forward it |
| `next` / `stepIn` / `stepOut` (`:221-234`) | Forward `request.arguments.threadId` |
| `continue` (`:216-219`) | Unchanged; `allThreadsContinued: true` stays correct |
| `scopes` / `variables` / `evaluate` (`:454-486`) | Unchanged — ids carry the thread |
| `initialize` (`:176-186`) | Unchanged; **not** advertising `supportsSingleThreadExecutionRequests` is deliberate (research R10) |

## Invariants

1. A `threadId` the webview does not know is an error response, never a silent fallback to thread 1.
2. `dbg:stopped` always names a live thread.
3. `dbg:threadStarted` precedes any `dbg:stopped` naming that thread.
4. `dbg:terminated` is sent exactly once per session, when the **program** ends.
5. Frame ids and `variablesReference` values are unique across threads (data-model §6), so
   `scopes`/`variables`/`evaluate` need no thread argument.
