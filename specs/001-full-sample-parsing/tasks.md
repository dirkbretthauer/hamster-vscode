---
description: "Task list for Full Sample-Program Parsing"
---

# Tasks: Full Sample-Program Parsing

**Input**: Design documents from `specs/001-full-sample-parsing/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: Requested. The spec says "Validate with a test" (FR-018, FR-019). Within each story, test tasks come
first and MUST fail before the implementation tasks that follow them.

**Organization**: Tasks are grouped by user story. US1 is parsing, US2 is runtime for exceptions, type tests,
and array literals, US3 is runtime for generics and `synchronized`, and US4 is the regression guard.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: The user story the task belongs to (US1–US4)

## Path Conventions

Single project at the repository root: language tools in `lang/`, webview runtime in `src/webview/`, scripts in
`scripts/`, unit tests in `test/`. Smoke tests use the existing `assert` style in `scripts/language-smoke.cjs`;
add new blocks just before the final `console.log('Language smoke checks passed')`.

---

## Phase 1: Setup

**Purpose**: Branch and baseline

- [X] T001 (Done on the user-created branch `speckit-001-full-sample-parsing` instead of `001-full-sample-parsing`.) Create and switch to branch `001-full-sample-parsing` from `main`, then commit the feature docs in `specs/001-full-sample-parsing/` (spec, plan, research, data-model, contracts, quickstart, checklists, tasks). Constitution: no direct commits to `main`.
- [X] T002 Run `node scripts/conformance.cjs` and confirm the baseline (TOTAL 808 passed / 112 failed). Append a "Baseline" line with those numbers and the date to `specs/001-full-sample-parsing/research.md`.

---

## Phase 2: Foundational (blocking prerequisites)

**Purpose**: Shared token and AST groundwork used by several stories. No behavior change on its own.

**⚠️ CRITICAL**: Complete before any user story work.

- [X] T003 Add `'synchronized'`, `'finally'`, and `'instanceof'` to the `KEYWORDS` set in `lang/hamster-lexer.js`. Then, in `lang/hamster-parser.js`, change the two `this.peek().value === 'finally'` checks in `parseTryStatement` to `this.checkKeyword('finally')`, so the existing "finally clauses are not supported" behavior is unchanged at this point.
- [X] T004 Add `SynchronizedStatement: 'SynchronizedStatement'`, `CatchClause: 'CatchClause'`, `InstanceofExpression: 'InstanceofExpression'`, and `ArrayInitializer: 'ArrayInitializer'` to `ASTNodeType` in `lang/hamster-parser.js`.
- [X] T005 Refactor `isFunctionAhead()` in `lang/hamster-parser.js` to skip modifiers with the existing `this.isModifierToken(...)` instead of its duplicated inline list. This is a pure refactor: run `npm test` and `node scripts/conformance.cjs` and confirm 808 still pass. Commit it separately (Principle VI: no refactor mixed with behavior).
- [X] T006 Add two helpers near the top of the IIFE in `scripts/language-smoke.cjs`: `parses(source, options = {})`, which calls `parser.parseProgram(source, { strict: true, ...options })` and returns the AST, and `parseFails(source, pattern)`, which asserts `parser.parseProgram(source, { strict: true })` throws an error whose message matches `pattern` and returns that error.

**Checkpoint**: `npm test` is green and the conformance result is unchanged (808 / 112).

---

## Phase 3: User Story 1 - Open book examples without false errors (Priority: P1) 🎯 MVP

**Goal**: All six requested constructs parse in every position the corpus uses, with erasure, and genuine errors
are still located.

**Independent Test**: `npm test` passes the new parse tests. `node scripts/conformance.cjs` shows no failures from
generics, `synchronized`, `finally`, multiple `catch`, `instanceof`, or array initializers.

### Tests for User Story 1 (write first, must fail)

- [X] T007 [US1] Add generics parse tests to `scripts/language-smoke.cjs` using `parses()`. Cover:
  - local `Speicher<Integer> k = new Speicher<Integer>();` (assert `varType === 'Speicher'` and NewExpression `callee.name === 'Speicher'`);
  - field `private Array<Pair<K, V>> entries;` (nested type arguments closing with `>>`);
  - a parameter and a return type `Pair<K, V> get(Array<? super T> a)`;
  - wildcards `?`, `? extends Hamster`, and `? super T`;
  - a cast `(Speicher<Integer>) obj`;
  - the diamond form `new Box<>()`;
  - `class Pair<K, V> {}` (assert `typeParameters` deep-equals `['K','V']`);
  - `class Box<T extends Hamster> {}`;
  - `/*class*/public interface Callable<V> {}`;
  - `class Summe implements Callable<Integer> {}` (assert `interfaces` deep-equals `['Callable']`);
  - `public static <T> void replace(Array<? super T> array, T obj) {}` inside a class (assert the method's `typeParameters` deep-equals `['T']`);
  - a global `Speicher<Integer> s = null;`.

  Also add comparison regressions with `parser.parseExpression`: `a < b`, `i < n && j > m`, and `x < y == z` must all produce `BinaryExpression`.
- [X] T008 [US1] Add `synchronized` parse tests to `scripts/language-smoke.cjs`:
  - the modifiers `synchronized static void f() {}`, `public synchronized void g() {}`, and `synchronized void put(ErzeugerHamster ham) {}` inside a class;
  - a block `synchronized (Territorium.getKachel(this.getReihe(),\n this.getSpalte())) { vor(); }`, asserting the statement `type === 'SynchronizedStatement'`;
  - a check that `parser.collectExecutableLines` includes the `synchronized` line and the line inside its body.
- [X] T009 [US1] Replace the three existing assertions in `scripts/language-smoke.cjs` that expect `/Multiple catch clauses are not supported/` and `/finally clauses are not supported/` (around the `try {} catch (Exception first) {} catch (Exception second) {}` block) with positive tests:
  - `try {} catch (A a) {} catch (B b) {}` gives `handlers.length === 2`, each with `type === 'CatchClause'`;
  - `try {} catch (A a) {} finally {}` gives a non-null `finalizer`;
  - `try {} finally {}` gives `handlers.length === 0` and a non-null `finalizer`;
  - `catch (final A a)` is accepted;
  - `parseFails('void main() { try {} }', /Expected catch or finally after try block/)`;
  - `collectExecutableLines` covers statements inside every catch body and the finally body.
- [X] T010 [US1] Add `instanceof` parse tests to `scripts/language-smoke.cjs` using `parser.parseExpression`:
  - `h instanceof BeuteHamster` gives `InstanceofExpression` with `targetType === 'BeuteHamster'` and `arrayDimensions === 0`;
  - `a instanceof B && c` gives a top-level `BinaryExpression` `&&` whose left side is `InstanceofExpression`;
  - `!(a instanceof B)` gives `UnaryExpression`;
  - `x instanceof pkg.Foo[]` gives `targetType === 'pkg.Foo'` and `arrayDimensions === 1`;
  - `x instanceof Box<T>` is erased to `'Box'`;
  - `parser.parseExpression('x instanceof int')` throws `/instanceof requires a reference type/`.
- [X] T011 [US1] Add array-initializer parse tests to `scripts/language-smoke.cjs`:
  - a local `int[] a = { 1, 2, 3 };` gives an `ArrayInitializer` with 3 elements;
  - `int[] e = {};`;
  - a trailing comma `{ 1, 2, }` gives 2 elements;
  - nested `int[][] m = { { 1, 2 }, { 3 } };`;
  - a field `private boolean[] kritisch = { false, false };`;
  - a global `boolean[] g = { true };`;
  - a `for` initializer `for (int[] r = { 1 }; false;) {}`;
  - `new int[] { 1, 2 }` gives a `NewExpression` with `dimensions` deep-equal to `[null]` and a non-null `initializer`;
  - `new int[][] { { 1 }, { 2 } }`;
  - `parseFails('void main() { int[] a = new int[3] { 1 }; }', /Array initializer not allowed with explicit dimensions/)`.
- [X] T012 [US1] Add diagnostics-stay-precise tests to `scripts/language-smoke.cjs` using `parser.collectProgramErrors(source, { requireMain: false })`:
  - a missing `}` after a `finally` block reports an error;
  - an unclosed type argument `Speicher<Integer k;` reports an error on that line;
  - `catch () {}` reports an error on its line;
  - `synchronized () {}` reports an error on its line.

### Implementation for User Story 1

- [X] T013 [US1] Implement `scanTypeArgumentsEnd(index)` in the `Parser` class of `lang/hamster-parser.js` (research D1). It must not consume tokens. If `tokens[index]` is `<`, it walks forward with a depth counter and accepts only: IDENTIFIER, `.`, `,`, `?` (SYMBOL `QUESTION`), the keywords `extends`/`super`/`int`/`boolean`, `[`, `]`, `<`, and `>`. It returns the index after the matching `>` that brings the depth to 0, or `-1` on any other token or at EOF. An empty `<>` returns `index + 2`. Also add `skipTypeArguments()`: when `scanTypeArgumentsEnd(this.current)` is ≥ 0, it advances `this.current` to that index and returns `true`.
- [X] T014 [US1] Erase type arguments in every type position in `lang/hamster-parser.js` by calling `skipTypeArguments()` right after the type name, so stored names never contain `<…>`:
  - in `consumeTypeName` (after an IDENTIFIER type) and in `consumeQualifiedName` (after the full dotted name);
  - after the callee name in the `new` branch of `parsePrimary`, before `(` or `[`;
  - in `parseCastExpression`.

  Then update the lookahead helpers to step over a type-argument span with `scanTypeArgumentsEnd` at the same points: `isTypeKeywordAhead` (an IDENTIFIER, optional type arguments, `[]` pairs, then an IDENTIFIER), `isFunctionAhead`, and `isCastAhead` (after the identifier and dotted parts, before the `[]` pairs). Run the T007 tests.
- [X] T015 [US1] Implement type parameters in `lang/hamster-parser.js`. Add `parseTypeParameters()`: if `checkOperator('<')`, it consumes `<`, then one or more `Identifier [extends Type]` separated by `,` (it reuses `consumeTypeName(false)` for the bound), then `>`, and returns the identifier names; otherwise it returns `[]`. Call it:
  - in `parseClassLikeDeclaration` right after the class or interface name, storing `typeParameters` on the node;
  - in class bodies after `parseModifiers()` and before `consumeTypeName(true)`, passing the result into `parseMethodRest` so `FunctionDeclaration.typeParameters` is set;
  - in `parseFunction` and `tryParseFunction` after the modifiers.

  `isFunctionAhead` must step over a leading `<…>` after the modifiers. Every class, interface, and function node gets `typeParameters: []` when it isn't generic. Run the T007 tests.
- [X] T016 [US1] Implement `synchronized` parsing in `lang/hamster-parser.js`:
  - add `'synchronized'` to `isModifierToken`;
  - in `parseStatement`, before the `isTypeKeywordAhead` check, add `if (this.checkKeyword('synchronized') && this.checkNextSymbol('('))` returning a new `parseSynchronizedStatement()`, which consumes the keyword and `(`, parses the lock with `parseExpression()`, consumes `)` ("Expected ) after synchronized lock"), and parses the body with `parseBlock()`, producing `{ type: SynchronizedStatement, lock, body, loc }`;
  - add `SynchronizedStatement` to `EXECUTABLE_STATEMENT_TYPES` and recurse into `node.body` in `collectExecutableLines`.

  Run the T008 tests.
- [X] T017 [US1] Rewrite `parseTryStatement` in `lang/hamster-parser.js` to the shape in `contracts/ast-nodes.md`:
  - after the `try` block, loop while `matchKeyword('catch')`: parse `(`, `parseModifiers()` (allows `final`), `consumeTypeName(false)` (erased), a parameter identifier, `)`, and a block, building `{ type: CatchClause, paramType, paramName, body, loc }`;
  - then `finalizer = this.matchKeyword('finally') ? this.parseBlock() : null`;
  - if `handlers.length === 0 && !finalizer`, throw `HamsterParserError('Expected catch or finally after try block', tryToken)` (data-model rule "`handlers.length > 0 || finalizer !== null`");
  - return `{ type: TryStatement, block, handlers, finalizer, loc }` and remove both "not supported" errors;
  - in `collectExecutableLines`, replace `node.handler?.body` with iteration over `node.handlers` bodies plus `node.finalizer`.

  Commit this task together with T027 (the runner change) so the runner never sees the new shape unhandled (Principle II).
- [X] T018 [US1] Implement `instanceof` parsing in `parseRelational` in `lang/hamster-parser.js`: inside the loop, `if (this.matchKeyword('instanceof'))`.
  - Read the target type:
    - a primitive keyword (`int`/`boolean`) is only allowed when followed by `[]`; otherwise throw `HamsterParserError('instanceof requires a reference type', token)`;
    - otherwise `consumeQualifiedName`, which already erases type arguments via T014;
    - count trailing `[]` pairs.
  - Build `{ type: InstanceofExpression, argument: expr, targetType, arrayDimensions, loc: locationFrom(keywordToken) }` and continue the loop.

  Run the T010 tests.
- [X] T019 [US1] Implement array initializers in `lang/hamster-parser.js`.
  - Add `parseVariableInitializer()`, which returns `this.checkSymbol('{') ? this.parseArrayInitializer() : this.parseExpression()`.
  - Add `parseArrayInitializer()`, which consumes `{`, then zero or more `parseVariableInitializer()` separated by `,` with an optional trailing `,`, then `}` ("Expected } to close array initializer"), producing `{ type: ArrayInitializer, elements, loc }`.
  - Use `parseVariableInitializer()` instead of `parseExpression()` after `=` in `parseVariableDeclaration`, `parseForVariableDeclaration`, `parseFieldRest`, and `tryParseGlobalVariable`.
  - In `parseArrayDimensionsRest`: if every dimension is `null` and `checkSymbol('{')`, set `initializer = this.parseArrayInitializer()`. If any dimension is sized and `checkSymbol('{')`, throw `HamsterParserError('Array initializer not allowed with explicit dimensions', this.peek())`. Always include `initializer` (default `null`) on `NewExpression`.

  Commit this task together with T029. Run the T011 tests.
- [X] T020 [US1] Run `npm test` (the T007–T012 tests pass, including the T012 diagnostics) and `node scripts/conformance.cjs`. Confirm that no remaining failure message comes from the six requested constructs and that passed ≥ 808. Fix any parse gap found in the corpus output (e.g. a type-argument position not covered by T014) in `lang/hamster-parser.js` and add a smoke test for it.

**Checkpoint**: Every in-scope sample parses. Programs with `try`/initializers also need US2 runner tasks T027/T029
before merging (Principle II).

---

## Phase 4: User Story 2 - Run programs using exceptions, type tests, and array literals (Priority: P2)

**Goal**: Java semantics at runtime for multiple `catch`, `finally`, `instanceof`, and array initializers.

**Independent Test**: The execution smoke tests from T021–T024 pass under `npm test`.

### Tests for User Story 2 (write first, must fail)

- [X] T021 [US2] Add multiple-`catch` execution tests to `scripts/language-smoke.cjs` using `runProgram(...)` and global result variables:
  - `catch (KachelLeerException e)` before `catch (HamsterException e)` with a thrown `KachelLeerException` runs only the first clause;
  - a thrown `MauerDaException` skips a non-matching first clause and runs a matching second clause;
  - an earlier supertype clause (`HamsterException`) wins over a later subtype clause;
  - an exception that no clause matches propagates (`assert.throws` with `HamsterLanguageException`).
- [X] T022 [US2] Add `finally` execution tests to `scripts/language-smoke.cjs`. The finally block increments a global `count` in each case; assert both `count` and the outcome:
  - normal completion;
  - a caught exception (the finally runs after the catch);
  - an uncaught exception (the finally runs, then the exception propagates; check `count` on the state after `assert.throws` by building the state manually with `createRunnerState` and stepping with `executeRunnerStep`);
  - `return` inside `try` in a function (the finally runs, the returned value is kept);
  - `break` inside `try` inside a loop (the finally runs once, the loop exits);
  - `return 2` inside `finally` overrides `return 1` from `try`;
  - `throw` inside `finally` replaces a caught or normal outcome;
  - `try {} finally {}` without catch;
  - nested `try` with an inner `finally` and an outer catch (the order of finally side effects is inner first).
- [X] T023 [US2] Add `instanceof` execution tests to `scripts/language-smoke.cjs`, reusing the cast test classes (`interface Marker`, `class Base`, `class Derived extends Base implements Marker`, `class Other`). Assert:
  - `derived instanceof Base`, `instanceof Derived`, and `instanceof Marker` are all true;
  - `base instanceof Derived` is false for `new Base()`, and `derived instanceof Other` is false;
  - `null instanceof Base` is false;
  - `"text" instanceof String` and `derived instanceof Object` are true;
  - `Hamster.getStandardHamster() instanceof Hamster` is true via `createRuntime()`;
  - for `class MyHamster extends Hamster`, `new MyHamster() instanceof Hamster` is true;
  - `new int[2] instanceof int[]` is true and `new int[2] instanceof Base` is false.
- [X] T024 [US2] Add array-initializer execution tests to `scripts/language-smoke.cjs`:
  - local `int[] a = { 1, 2, 3 }` gives `[1,2,3]`;
  - nested `{ {1, 2}, {3} }` gives `[[1,2],[3]]`;
  - `{}` gives `[]`;
  - elements are expressions evaluated left to right (`{ next(), next() }` with a counter function gives `[1,2]`);
  - a class field `boolean[] kritisch = { false, false };` read via an instance method gives `[false,false]`;
  - a global `boolean[] g = { true, false };` gives `[true,false]` (constant folding);
  - `new int[] { 4, 5 }` gives `[4,5]`;
  - `new int[][] { {1}, {2} }` gives `[[1],[2]]`.

### Implementation for User Story 2

- [X] T025 [US2] Add `isInstanceOf(value, node, state)` next to `castValue` in `lang/hamster-runner.js` (research D5):
  - `null`/`undefined` → `false`;
  - `node.arrayDimensions > 0` → `Array.isArray(value)`;
  - an array value with no dimensions → `node.targetType === 'Object'`;
  - otherwise let `target = simpleTypeName(node.targetType)`; `'Object'` → `true`;
  - a string with `target === 'String'` → `true`;
  - `runtimeTypeName(value)` null → `false`, otherwise `isAssignableToType(state, valueType, target)`.

  Add `case ASTNodeType.InstanceofExpression: return isInstanceOf(yield* evalExpressionGen(node.argument, state, callDepth), node, state);` in `evalExpressionGen`. Commit together with T018. Run the T023 tests.
- [X] T026 [US2] Confirm that `validateDebuggerExpression` in `lang/hamster-runner.js` still allows the read-only `InstanceofExpression` (it walks child nodes generically) and still rejects `NewExpression`. Then add a smoke assertion in `scripts/language-smoke.cjs` that `runner.evaluateExpression(parser.parseExpression('value instanceof Object'), expressionState, 1)` returns `true` with the existing `expressionState` setup.
- [X] T027 [US2] Replace `case ASTNodeType.TryStatement` in `lang/hamster-runner.js` with the outcome model in `data-model.md` ("Try-statement outcome"). Do not use a JavaScript `finally` around `yield*` (research D4: `generator.return()` during debugger cleanup must not run user code).
  - Add `function* executeTryStatementGen(node, state, callDepth)`. It runs `node.block` inside `try/catch`, capturing `{ kind: 'completed', value: result }` or `{ kind: 'threw', error }`.
  - If an error was thrown, it is a `HamsterLanguageException`, and `node.handlers.find(h => exceptionMatchesType(error.value, h.paramType, state))` finds a handler: run that handler's body with `state.scopes.push(new Map([[handler.paramName, error.value]]))`, popping the scope in a `try/finally` that contains no `yield`. The handler's own completion or throw replaces the outcome.
  - If `node.finalizer` is set: run it, capturing its outcome the same way. If it threw, rethrow its error. If its result `isControlSignal(...)`, return that result.
  - Finally, rethrow the captured error or return the captured value.

  Commit together with T017. Run the T021 and T022 tests.
- [X] T028 [US2] Make sure the scope stack is balanced after every `try` path in `lang/hamster-runner.js`. Add a smoke assertion in `scripts/language-smoke.cjs` that `state.scopes.length === 1` after the T022 programs complete, like the existing `exceptionState.scopes.length` check.
- [X] T029 [US2] Implement array initializers in `lang/hamster-runner.js`:
  - add `case ASTNodeType.ArrayInitializer:`, which evaluates `node.elements` left to right with `yield* evalExpressionGen` (nested initializers recurse through the same case) and returns the JavaScript array;
  - in `evalArrayCreationGen`, return `yield* evalExpressionGen(node.initializer, state, callDepth)` first when `node.initializer` is set;
  - in `createRunnerState`, replace the literal-only global initializer check with `constantInitializerValue(g.initializer)`. That helper returns `{ isConstant: true, value }` for a `Literal`, or for an `ArrayInitializer` whose leaves are all constant (recursively building arrays), and `{ isConstant: false }` otherwise. Non-constant globals keep their default value, as today (research D6).

  Commit together with T019. Run the T024 tests.

**Checkpoint**: US1 + US2 are mergeable. Every construct with runtime meaning except `synchronized` now executes.

---

## Phase 5: User Story 3 - Run programs using generics and synchronized (Priority: P3)

**Goal**: Generic user classes run with erasure. `synchronized` evaluates its lock and runs its body once. Library
classes and threads fail with clear messages.

**Independent Test**: The T030–T032 tests pass under `npm test`, and `node --test` passes `test/simulatorRuntime.test.mjs`.

### Tests for User Story 3 (write first, must fail)

- [X] T030 [US3] Add a generics execution test to `scripts/language-smoke.cjs` using a user-defined `class Box<T> { T value; Box(T v) { value = v; } T get() { return value; } }`. Use it as `Box<Integer>` and `Box<Base>`, plus `static <T> T first(Box<T> b) { return b.get(); }`. Assert the results equal those of an identical program with all `<…>` removed. Also assert that an uninitialised field of type `T` defaults to `null`.
- [X] T031 [US3] Add `synchronized` execution tests to `scripts/language-smoke.cjs`:
  - the lock expression `lock()` (a function that increments a global `locks` and returns an object) is evaluated exactly once per entry;
  - the body runs exactly once, also when entered in a loop 3 times (`locks === 3`, body count 3);
  - `return` and `break` inside the block propagate;
  - a `synchronized` method is callable normally;
  - `synchronized (null) {}` throws `/Cannot synchronize on null/`.
- [X] T032 [P] [US3] Create `test/simulatorRuntime.test.mjs` (node:test).
  - Load `src/webview/simulator/runtime.js`, `src/webview/simulator/engine.js`, and `src/webview/shared/terrainEngineState.js` as ES modules via `data:` URLs, rewriting their relative import specifiers (the same technique as `loadLanguageModules` in `scripts/language-smoke.cjs`).
  - Build the runtime with `createHamsterRuntime({ engine, getEngineState, appendLog: () => {}, readTerminalValue: () => 0 })` from `createSimulatorEngine()` after `initEngine(5, 5)`.
  - Assert:
    - `callMethod(createObject('ArrayList', []), 'add', [1])` throws a message containing `ArrayList` and `not provided by the Hamster simulator`;
    - `callMethod(<default hamster>, 'start', [])` throws a message matching `/threads.*not supported/i`;
    - `callBuiltin('Thread.sleep', [10])` throws the same thread message.

### Implementation for User Story 3

- [X] T033 [US3] Add `case ASTNodeType.SynchronizedStatement:` to `executeStatementGen` in `lang/hamster-runner.js`: evaluate `node.lock` with `yield* evalExpressionGen`, throw `new Error('Cannot synchronize on null')` when it is `null`/`undefined`, then `return yield* executeStatementGen(node.body, state, callDepth)` (research D3: single-threaded, no real lock). Commit together with T016. Run the T031 tests.
- [X] T034 [US3] Verify erasure end to end with the T030 test. If the runner trips over a type-parameter name (e.g. `T` resolved as a class reference by `runtime.resolveIdentifier` because it is capitalised), handle it in `lang/hamster-runner.js` by treating declared type parameters as non-class names. Record any such change in `specs/001-full-sample-parsing/research.md` under D2.
- [X] T035 [US3] Implement the FR-014 messages in `src/webview/simulator/runtime.js` (research D8):
  - add `const THREAD_METHOD_NAMES = new Set(['start', 'join', 'wait', 'notify', 'notifyAll', 'interrupt', 'sleep'])` and a helper `unsupportedThreadError(name)` returning ``new Error(`Hamster threads (${name}) are not supported by this extension`)``;
  - in `callMethod`, throw it for hamster or object receivers when the method name is in the set and is not otherwise handled;
  - for `receiver.__kind === 'object'`, replace the generic "Unsupported method call" with ``` `${receiver.className}.${methodName}: class ${receiver.className} is not provided by the Hamster simulator` ```;
  - in `callBuiltin`, when `receiverName === 'Thread'`, throw `unsupportedThreadError(rawMethodName)`.

  Run the T032 tests.

**Checkpoint**: US1–US3 are complete. All in-scope constructs parse and run as far as the single-thread model
allows.

---

## Phase 6: User Story 4 - Guard against regressions (Priority: P4)

**Goal**: Known-gap programs are reported separately with a code, and the corpus gate passes at 100% for in-scope
programs.

**Independent Test**: `node scripts/conformance.cjs --min-pass-rate=1` exits 0 with Failed 0 and a Known gaps
section. Breaking one construct makes `npm test` and the gate fail (quickstart step 3).

### Tests for User Story 4 (write first, must fail)

- [X] T036 [US4] Add known-gap error tests to `scripts/language-smoke.cjs`. Each source must throw an error whose `unsupportedConstruct` equals the given code and whose message matches the data-model table:
  - `void main() { reversi.ReversiHamster paul = null; }` → `qualified-type-name`;
  - `class C { java.util.Calendar c; }` → `qualified-type-name`;
  - `void main() { Hamster a = null, b = null; }` → `multiple-declarators`;
  - `/*object-oriented program*/enum Richtung { NORD } void main() {}` → `enum`;
  - `void main() { Object o = Hamster.class; }` → `class-literal`;
  - `void main() { int x = 0L; }` → `long-literal` (`HamsterLexerError`);
  - `void main() { for (Hamster h : alle) {} }` → `enhanced-for`.

  Also assert that `collectProgramErrors` reports each one with a line and column, and that multiple field declarators (`class C { int a = 1, b = 2; }`) still parse, since they are already supported.

### Implementation for User Story 4

- [X] T037 [US4] Add an optional `unsupportedConstruct` constructor parameter (default `null`), stored on the instance, to `HamsterParserError` in `lang/hamster-parser.js` and `HamsterLexerError` in `lang/hamster-lexer.js`. Add `unsupportedConstruct?: string` to `HamsterLanguageError` in `lang/hamster-parser.d.ts`. Add a frozen `UnsupportedConstruct` map exporting the six codes in `lang/hamster-parser.js`, to avoid magic strings.
- [X] T038 [US4] In `lang/hamster-lexer.js` `scanToken`, after `readNumber`: if `this.peek()` is `L` or `l`, consume it and throw `new HamsterLexerError('long literals are not supported', startLine, startColumn, this.index - startIndex, 'long-literal')`.
- [X] T039 [US4] Implement the parser detections in `lang/hamster-parser.js`, each throwing `HamsterParserError(message, token, code)` with the messages from `data-model.md`:
  - `qualified-type-name`: in `parseStatement`/`tryParseGlobalVariable` and the class-member path, when the tokens are IDENTIFIER (`.` IDENTIFIER)+, optional type arguments, then IDENTIFIER;
  - `multiple-declarators`: in `parseVariableDeclaration` and `tryParseGlobalVariable`, when `,` follows a declarator (fields keep their existing multi-declarator support in `parseFieldRest`);
  - `enum`: in `parseCompatibilityProgram` and the class body, when the IDENTIFIER `enum` is followed by IDENTIFIER and `{`;
  - `class-literal`: in `parsePostfix` after `.`, when `checkKeyword('class')`;
  - `enhanced-for`: in `parseForStatement`, when a type and identifier are followed by the SYMBOL `:`.

  `tryParseGlobalVariable` and `tryParseFunction` swallow errors for rollback today. They MUST rethrow any error whose `unsupportedConstruct` is set. Run the T036 tests.
- [X] T040 [US4] Extend `scripts/conformance.cjs` per `contracts/conformance-cli.md` and the data-model "Conformance result model":
  - classify a failure as `known-gap` when `error.unsupportedConstruct` is set;
  - add a `Known gaps` column to the per-type table;
  - print a `Known gaps (out of scope)` section grouped by code, with counts and example `file:line` (all files with `--verbose`);
  - compute the pass rate as `passed / (passed + failed)`, excluding known gaps, and apply `--min-pass-rate` to it;
  - keep exit codes 0/1/2/3 as specified.
- [X] T041 [US4] Run `node scripts/conformance.cjs --min-pass-rate=1` and confirm exit code 0, `Failed 0`, passed ≥ 808 (no regressions, FR-016), and about 10 known gaps, each with one of the six codes. If an in-scope failure remains, fix it in `lang/hamster-parser.js` with a smoke test. If a known-gap program hides a second in-scope construct, note it in `specs/001-full-sample-parsing/research.md` (D7 limitation). Record the final numbers in `research.md` next to the baseline from T002.
- [X] T042 [US4] Perform the deliberate-regression check from `specs/001-full-sample-parsing/quickstart.md` step 3: temporarily disable `finally` parsing, confirm that `npm test` fails and that `node scripts/conformance.cjs --min-pass-rate=1` exits 3, then revert (SC-005).

**Checkpoint**: All four stories are complete and the gate is green.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [X] T043 [P] Update `syntaxes/hamster.tmLanguage.json` (FR-020, research D10): add `finally` to the `keyword.control.hamster` regex, `synchronized` to the `storage.modifier.hamster` regex, and a `keyword.operator.instanceof.hamster` pattern `\\binstanceof\\b` in `repository.operators.patterns`.
- [X] T044 [P] Update `.agents/skills/hamster-language/SKILL.md` (FR-021):
  - remove `instanceof` from the Lexer, Parser, and Runner gap lists;
  - replace the parser gap bullet listing generics/synchronized/finally/etc. with the six known gaps and their `unsupportedConstruct` codes;
  - mention `node scripts/conformance.cjs --min-pass-rate=1` as the target in the Testing section;
  - document the new AST nodes in the "Adding a new statement/expression" guidance if useful.
- [X] T045 [P] Update `spec/vscode-port-status.md` (FR-021, Principle I):
  - mark `instanceof`, multiple `catch`, `finally`, generics (erased), `synchronized`, and array initializers as 🟢 in sections 1–3;
  - add a ⚪ deviation note that `synchronized` performs no locking because the runner is single-threaded;
  - list the six known-gap constructs;
  - update the Executive Summary's Band 2 status.
- [X] T046 [P] Add an "Unreleased" section to `CHANGELOG.md` listing the newly supported constructs, the clearer "not supported" messages for the six known gaps and for library classes and threads, and the conformance gate.
- [X] T047 Run the full validation from `specs/001-full-sample-parsing/quickstart.md` steps 1, 2 and 4 (`npm test`, `node scripts/conformance.cjs --min-pass-rate=1`, `npm run compile`), and confirm `npm test` takes under 10 s (SC-004).
- [ ] T048 Manual check (needs a human; Principle V): quickstart step 5 in the Extension Development Host (F5) and one sample in the Web Extension Host. Record the result in the PR test plan.
- [ ] T049 Push branch `001-full-sample-parsing` and open a PR against `main`. The description summarises the per-construct commits, the conformance numbers before and after (from T002/T041), and the test plan, with T048 unchecked until it is done.

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (T001–T002)** → **Foundational (T003–T006)** → user stories → **Polish (T043–T049)**.
- **US1 (T007–T020)** comes first. US2 and US3 runner tasks depend on the US1 parser task that produces their
  node: T027 needs T017, T029 needs T019, T025 needs T018, T033 needs T016, T034 needs T014/T015.
- **US2** and **US3** are independent of each other once their US1 parser tasks are done.
- **US4** depends on US1 (it needs the in-scope failures gone to see only known gaps). Its tests (T036–T039) can
  start right after Foundational because they only touch error metadata, but T041 needs US1–US3 complete.

### Commit grouping (Principles II and VI: one logical change per commit, no node without a runner case)

| Commit | Tasks |
|---|---|
| Refactor modifier lookahead | T005 |
| Generics | T007, T013–T015, T030, T034 |
| `synchronized` | T008, T016, T031, T033 |
| `try` with multiple `catch` and `finally` | T009, T017, T021, T022, T027, T028 |
| `instanceof` | T010, T018, T023, T025, T026 |
| Array initializers | T011, T019, T024, T029 |
| Known-gap errors + conformance gate | T036–T041 |
| Library/thread runtime messages | T032, T035 |
| Highlighting + docs | T043–T046 |

T003, T004, T006 (groundwork), T012 (diagnostics tests) and T020 can go into the first construct commit that
needs them.

### Within each story

Tests are written first and must fail. Then comes the parser, then the runner, and the story checkpoint
validation comes last.

## Parallel Opportunities

Most tasks edit `lang/hamster-parser.js`, `lang/hamster-runner.js`, or `scripts/language-smoke.cjs`, so they
are sequential within a file. Real parallelism:

- **T032 + T035** (`test/simulatorRuntime.test.mjs`, `src/webview/simulator/runtime.js`) can run alongside any
  `lang/` work.
- **T043, T044, T045, T046** touch four different files and can run together once behavior is final.
- **T037/T038** (lexer and error classes) can run alongside US2 runner tasks.

### Parallel example: Polish

```text
Task: "Update syntaxes/hamster.tmLanguage.json keywords (T043)"
Task: "Update .agents/skills/hamster-language/SKILL.md gap list (T044)"
Task: "Update spec/vscode-port-status.md (T045)"
Task: "Add CHANGELOG.md Unreleased entry (T046)"
```

### Parallel example: User Story 3

```text
Task: "Create test/simulatorRuntime.test.mjs (T032)"   # src/webview + test/
Task: "Add synchronized execution tests (T031)"          # scripts/language-smoke.cjs
```

## Implementation Strategy

### MVP

US1 alone already removes every false syntax error (the most visible value). Because of Principle II, it must not
be merged without the runner cases for the nodes it introduces. The smallest mergeable MVP is therefore
**US1 + T025/T027/T029/T033** (the runner cases), with the rest of US2/US3 testing done alongside.

### Incremental delivery

1. Setup + Foundational. Conformance stays at 808.
2. Generics commit. This gives the biggest jump (~34 programs).
3. `synchronized` commit (~47 programs).
4. The `try`, `instanceof`, and array-initializer commits.
5. Known-gap errors + gate. Conformance reaches 100% in scope.
6. Runtime messages, docs, and the PR.

After every commit: `npm test` is green and the conformance passed count never decreases.

## Notes

- [P] = different files, no dependency on incomplete tasks.
- Quote the constraints from `data-model.md` exactly when implementing (e.g. the `try` rule and "Type names stored
  in AST fields never contain `<…>`").
- Do not edit `AGENTS.md`. Its paths are correct as written.
