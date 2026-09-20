# Copilot Instructions – hamster-vscode

VS Code extension that runs and visualises [Hamster Simulator](https://www.java-hamster-modell.de/)
programs (`.ham` files) with an integrated simulator webview, terrain editor, and debugger.

## Architecture

- **`lang/`** – Plain JavaScript (ES modules), no build step, loaded by both webpack (webview) and
  `src/diagnostics.ts` (via `stripEsModule()` + `new Function()`):
  - `hamster-lexer.js` – tokenizes `.ham` source
  - `hamster-parser.js` – recursive-descent parser producing a plain-object AST (two entry points:
    normal `parseProgram` for imperative Band-1 programs, and `parseCompatibilityProgram` for
    "flattened" OO programs)
  - `hamster-runner.js` – generator-based (`function*`) interpreter that walks the AST and yields
    `{ kind: 'instruction', ... }` / `{ kind: 'needsInput', ... }` steps for the UI
- **`src/`** – TypeScript, the VS Code extension host:
  - `extension.ts` – activation, commands (`hamster.openSimulator/compile/run/step/stop/reset`)
  - `hamsterPanel.ts` – webview panel bridging the runner to the simulator UI
  - `diagnostics.ts` – runs the parser on save/change for red-squiggle errors
  - `terrainEditor.ts` – custom editor for `.ter` terrain files
  - `hamsterDebugSession.ts` – Debug Adapter Protocol implementation for step debugging
- **`syntaxes/hamster.tmLanguage.json`** – TextMate grammar for syntax highlighting
- **`spec/`** – Local copies of the reference language spec

**Reference implementation**: the authoritative language behavior comes from the real Java
Hamster Simulator sources, not just docs. When verifying language semantics, check:
`D:\Projects\hamstersimulator-v29-06-eclipse\hamstersimulator-v29-06-eclipse\hamstersimulator-2.9.6\spec\hamster-language.md`
(spec) and the Java sources under `...\hamstersimulator-2.9.6\de\hamster\` (e.g.
`de/hamster/debugger/model/{IHamster,Hamster,Territorium,Territory}.java` for the built-in API,
`de/hamster/compiler/model/Precompiler.java` for program-type wrapping). Prefer the Java source
over the markdown spec if they ever disagree, since the spec is a human-written summary of it.

## Working on language features

Use the `hamster-language` skill (`.agents/skills/hamster-language/SKILL.md`) whenever adding or
changing keywords, operators, statements, expressions, or other `.ham` language behavior — it has
a step-by-step guide for touching the lexer/parser/runner/grammar together and a "Current Feature
Gaps" backlog list. Keep that gap list in sync with reality: if a fix closes a gap (or the gap
description turns out to be wrong, e.g. dead code paths), update the skill file too.

Key conventions:
- AST nodes are plain objects: `{ type, ...fields, loc: { line, column } }`.
- The runner must `yield*` when delegating to sub-generators (cooperative multitasking with the UI).
- The parser uses a checkpoint/rollback pattern (`tryParseFunction`) for speculative parsing of
  ambiguous constructs — follow the same pattern for new ambiguous grammar.
- Every new AST node type needs a `case` in the parser's `ASTNodeType` set *and* a matching
  `case` in `hamster-runner.js`'s `executeStatementGen`/`evalExpressionGen`.

## Build & test

```bash
npm install
npm run compile       # webpack build
npm run watch          # webpack --watch
npm run package         # production build + vsce package (.vsix)
```

There is no automated test suite. After a change:
1. `npm run compile`
2. Press F5 in VS Code to launch the Extension Development Host
3. Open a `.ham` file and verify syntax highlighting, parser diagnostics (Problems panel), and
   correct simulator behavior for the changed feature

## Conventions

- `lang/*.js` files use ES module syntax (`export`/`import`) despite having no build step of
  their own — don't convert them to CommonJS.
- Keep `src/diagnostics.ts` in sync if parser error shapes change (`HamsterParserError` /
  `HamsterLexerError` must carry `line`/`column` for diagnostics to work).
- `.ham` programs pair with optional `.ter` terrain files of the same base name in the same folder.

## Coding style

These are general readability best practices to follow in new/changed code, even where the
existing code doesn't consistently follow them yet. Prefer small, incremental improvements in
touched code over large unrelated reformatting.

- **Naming** – Use descriptive, intention-revealing names (`parseWhileStatement`, not `pWS` or
  `handle2`). Avoid abbreviations except well-known ones (`ast`, `loc`, `idx`). Booleans read as
  predicates (`isTypeKeywordAhead`, `hasWall`), not flags (`typeFlag`).
- **Function size & focus** – Keep functions short and single-purpose; a function should do one
  thing at one level of abstraction. Extract a helper rather than growing a function with nested
  conditionals or mixed levels of detail.
- **Early returns / guard clauses** – Prefer returning early over deeply nested `if`/`else`
  pyramids. Flatten control flow where possible.
- **Comments explain "why", not "what"** – Code should be readable without comments describing
  what it does; add comments only for non-obvious rationale, edge cases, or gotchas (matches the
  existing repo rule of only commenting where clarification is needed).
- **Avoid magic values** – Named constants (or enums) instead of unexplained literals/strings
  scattered through the code, especially for things like token types, instruction kinds, or
  limits (e.g. loop guards).
- **Consistent error handling** – Throw/raise specific, typed errors with actionable messages and
  location info (as `HamsterParserError`/`HamsterLexerError` already do) rather than generic
  `Error`s or silent failures. Don't swallow exceptions without at least a comment explaining why.
- **Limit side effects** – Prefer pure functions and explicit return values over mutating shared
  state or out-parameters, except where a documented pattern already exists (e.g. the parser's
  token-cursor mutation, the runner's generator-based state).
- **Small, focused diffs** – One logical change per commit/PR; don't mix refactors with behavior
  changes so reviewers (and future debugging) can isolate cause and effect.
- **Type safety in TS (`src/`)** – Avoid `any`; prefer precise types/interfaces. Let the compiler
  catch mistakes rather than relying on runtime checks alone.
- **Consistent formatting** – Match the surrounding file's indentation, quote style, and brace
  style rather than introducing a new style within the same file.
- **Duplication** – Prefer extracting shared logic (e.g. a helper for consuming a symbol/keyword)
  over copy-pasting similar blocks, but don't over-abstract for a single use case.

## VS Code extension best practices

General guidance for `src/` (extension host) and `hamsterPanel.ts`'s webview code:

- **Dispose everything** – Every listener/subscription/panel must be pushed to
  `context.subscriptions` or the panel's own `disposables` array (already done for `HamsterPanel`)
  so it's cleaned up on deactivate/panel close. Never leak `onDid*` listeners.
- **Lazy, fast activation** – Keep `activate()` cheap and synchronous where possible; defer
  expensive work (webview creation, file I/O) until the user actually invokes a command, not on
  startup. Prefer specific `activationEvents`/`onLanguage`/command-based activation over `*`.
- **Webview security** – Keep the existing CSP + nonce pattern for every `<script>`/`<style>` tag;
  never inline unsandboxed script without a nonce, and always load local resources via
  `webview.asWebviewUri(...)`, never raw filesystem paths.
- **Typed, validated postMessage protocol** – Treat webview ⇄ extension `postMessage` payloads as
  untrusted input from the other side; define a discriminated-union message type and validate
  `message.type` before acting on it, on both ends.
- **Use the VS Code API surface, not Node directly, where possible** – Prefer
  `vscode.workspace.fs`/`vscode.Uri` over `fs`/raw paths so remote/virtual workspaces (Web
  extension, Codespaces) keep working; this extension already ships a `browser` entry point, so
  avoid introducing Node-only APIs in code paths shared with it.
- **Don't block the extension host** – Avoid synchronous heavy computation or file I/O on the
  main extension thread; use `async`/`await` and `vscode.window.withProgress` for long-running
  operations (e.g. big `.ham`/`.ter` file parsing).
- **Respect cancellation & re-entrancy** – Debounce/guard handlers like
  `onDidChangeTextDocument`/`onDidChangeActiveTextEditor` so rapid edits don't queue overlapping
  diagnostic or panel updates; use a `CancellationToken` for anything that can be superseded.
- **User-facing errors, not console noise** – Surface actionable failures via
  `vscode.window.showErrorMessage`/`showWarningMessage`; reserve `console.error` for developer
  diagnostics (Output channel), and never let a rejected promise from a fire-and-forget async call
  go unhandled.
- **Follow contribution-point conventions** – Command IDs, view IDs, and setting keys should stay
  namespaced under `hamster.*` (as already done); add new commands/settings to `package.json`
  `contributes` and keep titles/`when` clauses consistent with existing ones.
- **Test in both hosts** – Since this extension has a `browser` entry point, verify new features
  work in the Web Extension Host too (`Developer: Open Web Extension Host` or `vscode.dev`), not
  just the desktop Extension Development Host.
