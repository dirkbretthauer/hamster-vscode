<!--
Sync Impact Report
==================
Version change: (unratified template) → 1.0.0
Modified principles: n/a (initial ratification; all placeholders replaced)
Added principles:
  - I. Reference Fidelity
  - II. Language Pipeline Integrity
  - III. Webview Security & Typed Message Protocol
  - IV. Web-Compatible, Well-Behaved Extension Host
  - V. Test-Backed Changes
  - VI. Simplicity & Focused Changes
Added sections:
  - Technology & Architecture Constraints
  - Development Workflow & Quality Gates
  - Governance
Removed sections: none
Templates requiring updates:
  - .specify/templates/plan-template.md ✅ no change needed (its Constitution Check gate reads
    this file at runtime)
  - .specify/templates/spec-template.md ✅ no change needed
  - .specify/templates/tasks-template.md ✅ no change needed
  - .specify/templates/checklist-template.md ✅ no change needed
Runtime guidance: AGENTS.md is consistent with this constitution (it is the source of most rules).
Follow-up TODOs: none
-->

# Hamster Simulator for VS Code Constitution

## Core Principles

### I. Reference Fidelity

The Java Hamster Simulator (v2.9.6) is the authority for language and simulator behavior.

- Language semantics, the built-in Hamster API, program-type handling, and the `.ter` format MUST
  match the Java sources (`de/hamster/debugger/model/*`, `de/hamster/compiler/model/Precompiler.java`,
  `de/hamster/model/HamsterFile.java`, `de/hamster/simulation/model/Terrain.java`). Where the
  reference spec markdown and the Java sources disagree, the Java sources win.
- Any intentional deviation (an extension such as `@default` in `.ter` files, a safety limit, a
  deliberate leniency) MUST be documented in `spec/vscode-port-status.md`.
- `.ter` files written by the extension MUST remain loadable by the reference simulator.
- The "Current Feature Gaps" list in `.agents/skills/hamster-language/SKILL.md` MUST be updated in
  the same change that closes, narrows, or discovers a gap.

Rationale: students and teachers move between the original simulator and this extension; programs
and terrains must behave the same in both.

### II. Language Pipeline Integrity

The lexer, parser, runner, and grammar form one pipeline and change together.

- `lang/*.js` MUST stay plain ES modules (`export`/`import`) with no build step of their own; they
  MUST NOT be converted to CommonJS.
- AST nodes MUST be plain objects `{ type, ...fields, loc: { line, column } }`. Every new node type
  MUST be registered in the parser's `ASTNodeType` and handled in `hamster-runner.js`
  (`executeStatementGen` or `evalExpressionGen`).
- The runner MUST delegate to sub-generators with `yield*` so stepping, breakpoints, and terminal
  input keep working.
- Ambiguous grammar MUST use the existing lookahead or checkpoint/rollback patterns rather than
  ad-hoc backtracking.
- Parse and lex failures MUST throw `HamsterParserError`/`HamsterLexerError` carrying line,
  column, and length so diagnostics and the debugger can locate them.
- New keywords, operators, or built-ins MUST be reflected in `syntaxes/hamster.tmLanguage.json`.

Rationale: diagnostics, the simulator, and the debugger all consume the same AST and generator
protocol; a change in one place silently breaks the others.

### III. Webview Security & Typed Message Protocol

- Every webview `<script>` MUST carry the per-load nonce under the existing Content Security
  Policy; local resources MUST be loaded via `webview.asWebviewUri(...)`, never raw paths.
- Messages between the extension host and webviews MUST be defined as discriminated unions in
  `src/webviewProtocol.ts` and validated with type guards before any field is read, on both ends.
  Unknown or malformed messages MUST be rejected, not acted upon.

Rationale: webview payloads are untrusted input; a single, validated contract keeps both webviews
and both host classes in agreement.

### IV. Web-Compatible, Well-Behaved Extension Host

- Code reachable from the `browser` entry point MUST NOT use Node-only APIs; file access MUST go
  through `vscode.workspace.fs` and `vscode.Uri`.
- Every listener, subscription, and panel MUST be disposed via `context.subscriptions` or an owning
  `disposables` array.
- `activate()` MUST stay cheap; expensive work (webview creation, file I/O, parsing large inputs)
  MUST be deferred until a command needs it and MUST NOT block the extension host thread.
- Handlers for rapid events (`onDidChangeTextDocument`, `onDidChangeActiveTextEditor`) MUST guard
  against overlapping or stale work.
- User-actionable failures MUST surface through `vscode.window.show*Message`; fire-and-forget
  promises MUST NOT leave rejections unhandled.
- Commands, settings, and views MUST be namespaced `hamster.*` and declared in `package.json`.

Rationale: the extension ships for desktop VS Code and vscode.dev; leaks, blocking work, or
Node-only calls break one of the two hosts.

### V. Test-Backed Changes

- `npm test` (language smoke suite + `node --test` unit suites) and `npm run compile` MUST pass
  before a change is merged.
- New or changed language behavior MUST add or update coverage in `scripts/language-smoke.cjs`;
  new pure helpers (terrain codec, resolvers, protocol guards) MUST get `test/` unit coverage.
- Parser or lexer changes MUST be checked with `npm run conformance` when the reference corpus is
  available, and MUST NOT lower the corpus parse rate unless the regression is intentional and
  justified in the change description.
- User-visible simulator, editor, or debugger changes MUST be verified manually in the Extension
  Development Host (F5), and in the Web Extension Host when the change touches code shared with
  the `browser` entry point.

Rationale: there is no automated webview or DAP integration suite, so fast regression tests plus
an explicit manual check are the safety net.

### VI. Simplicity & Focused Changes

- Each commit MUST contain one logical change; refactors MUST NOT be mixed with behavior changes.
- New and changed code MUST follow the AGENTS.md coding style: intention-revealing names, small
  single-purpose functions, guard clauses, named constants instead of magic values, comments that
  explain "why", and matching the surrounding file's formatting.
- TypeScript in `src/` MUST NOT introduce new `any`; prefer precise types and interfaces.
- Shared logic SHOULD be extracted instead of duplicated, but abstractions MUST NOT be introduced
  for a single use (YAGNI). Added complexity MUST be justified in the plan's Complexity Tracking.

Rationale: small, readable diffs keep cause and effect isolated for reviewers and future debugging.

## Technology & Architecture Constraints

- **Stack**: VS Code extension (`engines.vscode` ^1.85) with `main` (Node) and `browser`
  (web worker) entry points. The extension host is TypeScript in `src/`; the language tools (`lang/`)
  and webview runtimes (`src/webview/`) are plain JavaScript ES modules. Webpack produces the
  extension bundles and the `dist/webview/*.js` scripts (`hamster-lang.js`,
  `hamster-simulator.js`, `hamster-terrain-editor.js`).
- **Layer boundaries**: `hamsterPanel.ts` and `terrainEditor.ts` own only webview lifecycle and
  host integration. Engine, runtime, debugger, renderer, and UI logic live in `src/webview/**`.
  Terrain drawing and model helpers shared by both webviews live in `src/webview/shared/`; the
  `.ter` codec lives in `lang/hamster-terrain.js`.
- **Debugger**: the Debug Adapter Protocol implementation (`hamsterDebugSession.ts`) runs inline in
  the extension host and drives the runner in the simulator webview exclusively through `dbg:*`
  messages.
- **Files**: `.ham` programs pair with an optional `.ter` terrain of the same base name in the same
  folder; `/*class*/` programs below the entry file's folder are loaded as class modules.
- **Scope**: only the Java-like program types (imperative, object-oriented, class) are supported.
  Scheme/Prolog/Python/JavaScript/Ruby, Scratch/FSM/flowchart, LEGO, and 3D frontends are out of
  scope.

## Development Workflow & Quality Gates

- Work happens on a feature branch and lands on `main` through a pull request; nothing is
  committed directly to `main`.
- Spec Kit features live in `specs/NNN-feature-name/` (`spec.md`, `plan.md`, `tasks.md`). Every
  plan MUST pass the Constitution Check before design and again after design.
- Quality gates before merge: `npm test` and `npm run compile` pass; `npm run conformance`
  reports no unexplained regression for parser/lexer changes; manual F5 verification is recorded
  in the PR's test plan for user-visible changes.
- Documentation MUST be kept in sync in the same change: `AGENTS.md` for architecture or
  convention changes, the `hamster-language` skill for language changes and gaps,
  `spec/vscode-port-status.md` for conformance status, and `CHANGELOG.md` for user-visible
  features in a release.

## Governance

- This constitution supersedes conflicting practices. `AGENTS.md` is the runtime development
  guidance and MUST stay consistent with it; if the two conflict, the same change MUST amend one
  of them.
- Amendments are made through a pull request that updates this file with the rationale. Versions
  follow semantic versioning: MAJOR for removing or redefining a principle, MINOR for a new
  principle or section or materially expanded guidance, PATCH for clarifications and wording.
- Compliance is reviewed at two points: the Constitution Check in every `plan.md`, and PR review,
  where reviewers verify the quality gates and that any deviation is justified in Complexity
  Tracking. Rules apply to new and changed code; existing code is brought into line incrementally
  when touched.

**Version**: 1.0.0 | **Ratified**: 2026-10-05 | **Last Amended**: 2026-10-05
