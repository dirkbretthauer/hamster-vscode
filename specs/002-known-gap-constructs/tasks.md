---
description: "Task list for Close the Known-Gap Java Constructs (reduced workflow: spec + tasks)"
---

# Tasks: Close the Known-Gap Java Constructs

**Input**: [spec.md](./spec.md). Reduced workflow: there is no `plan.md`, `research.md`, or `contracts/`. The design
decisions and the Constitution Check that would normally live in `plan.md` are below.

**Tests**: Requested (FR-012). Within each construct, write the smoke tests first and confirm they fail.

**Stories**: US1 = parsing (920/920), US2 = runtime behavior. Each construct below delivers both for its
construct, so tasks carry `[US1]`/`[US2]` labels inside per-construct phases.

## Design notes (replaces plan.md)

| ID | Construct | Decision |
|---|---|---|
| N1 | `long` literals | The lexer reads `123L`/`123l` as an `INTEGER` token with the digits' value. No 64-bit semantics. |
| N2 | Several declarators | `parseVariableDeclaration`/`parseForVariableDeclaration`/`tryParseGlobalVariable` return a new `VariableDeclarationGroup { declarations: VariableDeclaration[] }` when there is more than one declarator. At top level, the declarations are spliced into `ast.globals`. The runner executes the declarations in order in the current scope, with no new scope. `collectExecutableLines` adds each declaration's line. Field multi-declarators are unchanged. |
| N3 | Qualified type names | Type positions accept `a.b.Type`. The stored type name is the simple name `Type`, like generics erasure. This covers `consumeTypeName`, lookahead (`isTypeKeywordAhead`, `isFunctionAhead`, `isCastAhead`), and class `superClass`/`interfaces` (simplified). `new a.b.Type()` keeps its MemberExpression callee; the runner resolves `simpleTypeName(...)` in `evalNewExpressionGen`, which also makes `new Outer.Inner()` find nested classes. Cast/`instanceof` `targetType` keep the qualified text, as in 001; the runner already simplifies them. |
| N4 | Class literals | `Name.class` in `parsePostfix` gives `ClassLiteral { typeName (simple), loc }`. The runner returns one canonical `{ __kind: 'classLiteral', name, toString }` per name from `state.classLiterals`. `x.getClass()` (0 args, typed receiver) returns the literal for `runtimeTypeName(x)`. |
| N5 | for-each | `parseForStatement` detects `Type name :` and builds `ForEachStatement { varType, name, iterable, body }`, with the body through `parseBreakableStatement`. The runner iterates arrays. Each iteration pushes a scope holding the loop variable and pops it in a `finally` that contains no `yield`. `break`/`return` behave as in `while`. `null` → `Cannot iterate over null`. A non-array → `for-each over <Type> is not supported (only arrays)`, where `<Type>` is `runtimeTypeName(v) ?? v.className ?? typeof v`. |
| N6 | varargs | `Parameter.isVarargs`, set when a parameter type is followed by three `.` symbols. A varargs parameter that is not last → `HamsterParserError('Varargs parameter must be last')`. The runner gets `acceptsArgumentCount(fn, n)`: exact `n === params` or, for varargs, `n >= params - 1`. Every arity lookup prefers exact arity (`findMethod`, top-level candidates, constructors, `this(...)`, superclass constructors). `bindArguments(fn, args)` packs the extra arguments into an array and passes an array argument in the varargs position through unchanged. |
| N7 | `enum` | `enum Name { A, B, }` (trailing `,`/`;` allowed) at top level, as a class member, and in class files. It produces a `ClassDeclaration` with `isEnum: true` and `enumConstants: string[]`, plus empty members. `createRunnerState` pre-populates the enum's static fields with frozen values `{ __kind: 'enum', __className, name, ordinal, toString() }`. Member calls on enum values: `name`, `ordinal`, `toString`, `equals`, `compareTo`, `hashCode`. Static calls on the enum class: `values()` (a fresh array in declaration order) and `valueOf(name)` (an unknown name → `No enum constant <Enum>.<name>`). `switch` resolves an unqualified Identifier case label against the discriminant's enum. Constant arguments, constant bodies, or members after `;` → a tagged known-gap error with the new code `enum-body` ("Enums with constructors, fields, or methods are not supported"). This keeps the `UnsupportedConstruct` mechanism in use (FR-010). |
| N8 | Debugger display | `dbgFormatValue` in `src/webview/simulator/debugger.js` shows enum values as `Richtung.OST` and class literals as `class Foo`. |

## Constitution Check (replaces plan.md gate)

| Principle | Status |
|---|---|
| I. Reference fidelity | ✅ Java semantics for each construct. Limits are documented: enums are constant-only, for-each covers arrays only, `long` is not 64-bit. Port-status and the skill gap list are updated (T034). |
| II. Pipeline integrity | ✅ New nodes `VariableDeclarationGroup`, `ClassLiteral`, `ForEachStatement` get `ASTNodeType` entries and runner cases in the same commit. Errors are located. `enum` gets highlighting. |
| III. Webview security/protocol | ✅ No protocol changes. `debugger.js` only changes its formatting. |
| IV. Web-compatible host | ✅ Pure JS in `lang/` and `src/webview/`. |
| V. Test-backed | ✅ Smoke tests per construct. Conformance must rise monotonically to 920/920 with `--min-pass-rate=1`. F5 check of the SC-003 samples (T037). |
| VI. Focused changes | ✅ One commit per construct (the commit table below). No refactors mixed in. |
| Workflow | ✅ Branch `speckit-002-known-gap-constructs`, PR to `main`. The reduced spec+tasks workflow is a user decision recorded in spec.md. |

No violations to justify.

## Format: `[ID] [P?] [Story] Description`

---

## Phase 1: Setup

- [X] T001 Commit `specs/002-known-gap-constructs/` (spec, tasks) plus the pending T049 tick in `specs/001-full-sample-parsing/tasks.md` on branch `speckit-002-known-gap-constructs`. Update `.specify/feature.json` to `specs/002-known-gap-constructs`.
- [X] T002 Run `node scripts/conformance.cjs` and confirm the baseline 904 passed / 0 failed / 16 known gaps.

---

## Phase 2: `long` literals (N1): commit "Accept long literals"

- [X] T003 [US1] In `scripts/language-smoke.cjs`, remove the `long-literal` row from `knownGapCases`. Add tests: `void main() { int x = 0L; }` parses, `parser.parseExpression('9223372036854775807L')` gives a `Literal` with value `9223372036854775807`, and a run with `x = 5L + 1;` gives 6.
- [X] T004 [US1] In `lang/hamster-lexer.js` `scanToken`, consume an `L`/`l` suffix and return the `INTEGER` token (value = the digits) instead of throwing. Remove `LongLiteral` from `UnsupportedConstruct`. Expected conformance: 906 passed / 14 known gaps.

## Phase 3: Several declarators (N2): commit "Support several variables in one declaration"

- [X] T005 [US1] [US2] Smoke tests in `scripts/language-smoke.cjs`. Remove both `multiple-declarators` rows. Add:
  - a local `MeinHamster paul = null, willi = null;` (assert the group node with 2 declarations);
  - a global `int a = 1, b = 2; void main() {}` (assert 2 entries in `ast.globals`);
  - a run of `int a = 1, b = a + 1;` (b === 2, showing left-to-right order and the shared scope);
  - `for (int i = 0, j = 10; i < j; i++, j--)`. If the comma update form is unsupported, use `for (int i = 0, j = 3; i < j; i++) {}`. Assert the loop runs 3 times;
  - `collectExecutableLines` covers each declaration line.
- [X] T006 [US1] In `lang/hamster-parser.js`, add `ASTNodeType.VariableDeclarationGroup`. Replace `rejectMultipleDeclarators()` with declarator loops in `parseVariableDeclaration`, `parseForVariableDeclaration`, and `tryParseGlobalVariable`; each returns a single `VariableDeclaration` or a group. `parseCompatibilityProgram` and `parseProgram` splice group declarations into `globals`. Add the group to `collectExecutableLines`. Remove `MultipleDeclarators` from `UnsupportedConstruct`.
- [X] T007 [US2] In `lang/hamster-runner.js`, add `case ASTNodeType.VariableDeclarationGroup`: execute each declaration with `yield* executeStatementGen` in the current scope. Expected conformance: 908 / 12 known gaps.

## Phase 4: Qualified type names (N3): commit "Resolve qualified type names by simple name"

- [X] T008 [US1] [US2] Smoke tests in `scripts/language-smoke.cjs`. Remove both `qualified-type-name` rows. Add:
  - `reversi.ReversiHamster paul = null;` (`varType === 'ReversiHamster'`);
  - a class field `java.util.Calendar c;`;
  - a parameter `void f(a.b.Box box)` (`paramType === 'Box'`);
  - a return type `a.b.Box make()`;
  - `class C extends pkg.Base implements pkg.Marker {}` (`superClass === 'Base'`, `interfaces` deep-equal `['Marker']`);
  - expression statements `Territorium.getAnzahlReihen();` and `a.b = 1;` still parse as before;
  - a run where `pkg.Box b = new pkg.Box(4); result = b.get();` with a user class `Box` gives 4, and `new Outer.Inner()` instantiates the nested class `Inner`.
- [X] T009 [US1] In `lang/hamster-parser.js`:
  - add a `consumeQualifiedTypeName()` helper that returns the token of the last segment; `consumeTypeName` uses it for IDENTIFIER types;
  - make the lookahead helpers skip `(. IDENTIFIER)*` after the first identifier: `isTypeKeywordAhead`, `isFunctionAhead`, `isCastAhead` already does;
  - `parseClassLikeDeclaration` stores `simpleTypeName` for `superClass`/`interfaces` (add a module-level `simpleTypeName` helper in the parser);
  - remove `isQualifiedTypeDeclarationAt`, the `QualifiedTypeName` checks, and the code.
- [X] T010 [US2] In `lang/hamster-runner.js` `evalNewExpressionGen`, use `simpleTypeName(resolveCalleeName(node.callee) || 'Object')` as `className`. Expected conformance: 911 / 9 known gaps.

## Phase 5: Class literals (N4): commit "Support class literals and getClass()"

- [X] T011 [US1] [US2] Smoke tests in `scripts/language-smoke.cjs`. Remove the `class-literal` row. Add:
  - parse `Object o = Hamster.class;`, giving `ClassLiteral` with `typeName === 'Hamster'`;
  - parse `pkg.Foo.class` (`typeName === 'Foo'`);
  - runs: `Foo.class == Foo.class` is true; `new Foo().getClass() == Foo.class` is true; `new Bar().getClass() == Foo.class` is false; `synchronized (Foo.class) { count = count + 1; }` runs once; `Missing.class == Missing.class` is true.
- [X] T012 [US1] In `lang/hamster-parser.js`: add `ASTNodeType.ClassLiteral`. In `parsePostfix`, after `.`, if `checkKeyword('class')`, consume it and build `{ type: ClassLiteral, typeName: simpleTypeName(resolveDottedName(expr)), loc }`; throw `Expected type name before .class` when `expr` isn't an Identifier/MemberExpression chain. Remove the `ClassLiteral` code.
- [X] T013 [US2] In `lang/hamster-runner.js`: add `state.classLiterals = new Map()` in `createRunnerState`, `classLiteralFor(state, name)` (canonical value with `toString()` → `class <name>`), and `case ASTNodeType.ClassLiteral`. In `evalCallExpressionGen`, for a member call with `methodName === 'getClass'`, 0 args, and `runtimeTypeName(receiver)` non-null, return `classLiteralFor(state, runtimeTypeName(receiver))` before the runtime fallback. Expected conformance: 915 / 5 known gaps.

## Phase 6: for-each (N5): commit "Support for-each loops over arrays"

- [X] T014 [US1] [US2] Smoke tests in `scripts/language-smoke.cjs`. Remove the `enhanced-for` row. Add:
  - parse `for (Belegung b : this.belegungen) {}`, giving `ForEachStatement`;
  - runs: sum over `int[] xs = { 1, 2, 3 }` gives 6; `break` after the first element; `return` from inside the loop in a function; nested for-each over `int[][]`;
  - `for (int x : null)` is a runtime error matching `/Cannot iterate over null/`;
  - with `createRuntime()` returning a placeholder `{ __kind: 'object', className: 'HashSet' }` from `new HashSet()`, iterating it throws `/for-each over HashSet is not supported/`;
  - `collectExecutableLines` includes the for-each line and its body;
  - a malformed `for (int x : ) {}` reports a located error.
- [X] T015 [US1] In `lang/hamster-parser.js`: add `ASTNodeType.ForEachStatement`. In `parseForStatement`, when `isTypeKeywordAhead()` and the token after the type and identifier is `:`, parse `parseForEachRest(forToken)`. Add the statement to `EXECUTABLE_STATEMENT_TYPES` and to `collectExecutableLines`, recursing into its body. Remove the `EnhancedFor` check and code.
- [X] T016 [US2] In `lang/hamster-runner.js`, add `case ASTNodeType.ForEachStatement` per N5. Expected conformance: 917 / 3 known gaps.

## Phase 7: varargs (N6): commit "Support varargs parameters"

- [X] T017 [US1] [US2] Smoke tests in `scripts/language-smoke.cjs`. Remove the `varargs` row. Add:
  - parse `void f(int... xs)` (`isVarargs === true`) and `addAll(Array<? super T> array, T... elements)`;
  - `parseFails` for `void f(int... a, int b)` with `/Varargs parameter must be last/`;
  - runs:
    - `sum()` = 0, `sum(1)` = 1, `sum(1, 2, 3)` = 6 for `int sum(int... xs)` using for-each;
    - `sum(new int[] { 4, 5 })` = 9 (array pass-through);
    - `f(1)` picks `f(int a)` over `f(int... a)`;
    - a static varargs method in a class (`Arrays.addAll(box, 1, 2)` modelled on the sample, with a user `Box` that collects added elements);
    - a varargs constructor.
- [X] T018 [US1] In `lang/hamster-parser.js` `parseParameter`, accept three consecutive `.` symbols after the type and set `isVarargs: true` (default `false`). Add `validateVarargsPosition(parameters)`, which throws on a non-last varargs parameter, and call it from `parseParameterList`, `parseFunction`, and `tryParseFunction`. Remove the `Varargs` check and code.
- [X] T019 [US2] In `lang/hamster-runner.js`, add `acceptsArgumentCount`, `selectByArity(candidates, count)` (exact arity first, then varargs), and `bindArguments`. Use them in `findMethod`, the top-level candidate lookup in `evalCallExpressionGen`, the arity checks in `invokeUserFunctionGen`, `instantiateClassGen`, the `this(...)` chaining in `invokeConstructorGen`, and `initializeSuperclassGen`; use `bindArguments` for parameter binding in `invokeUserFunctionGen` and `invokeConstructorGen`. Expected conformance: 918 / 2 known gaps.

## Phase 8: `enum` (N7, N8): commit "Support constant-only enums"

- [X] T020 [US1] [US2] Smoke tests in `scripts/language-smoke.cjs`. Replace both `enum` rows with an `enum-body` row: `enum E { A(1) }` gives `unsupportedConstruct === 'enum-body'`. Also cover `enum E { A; void f() {} }`. Add:
  - parse a top-level `enum Richtung { NORD, WEST, SUED, OST }`, a trailing comma, a trailing `;`, a nested enum in a class, and a `/*class*/ enum` file (class modules require `classes.length > 0`, so this checks the enum counts as a class);
  - `parseFails` for `enum E { , }`;
  - runs:
    - `Richtung.OST == Richtung.OST` and `Richtung.OST != Richtung.WEST`;
    - `name()`, `ordinal()`, `toString()`, and `"" + Richtung.OST` gives `"OST"`;
    - `values().length == 4` with the order NORD, WEST, SUED, OST;
    - `valueOf("SUED") == Richtung.SUED`;
    - `valueOf("X")` throws `/No enum constant Richtung.X/`;
    - `compareTo`;
    - passing an enum to a constructor (the `beispiel2.ham` pattern with a `RichtungsHamster extends Hamster` that calls `init` based on the enum);
    - `switch (r) { case WEST: … }`;
    - `r instanceof Richtung`.
- [X] T021 [US1] In `lang/hamster-parser.js`:
  - add `parseEnumDeclaration(modifiers)`, producing a `ClassDeclaration` with `isEnum: true`, `enumConstants`, `typeParameters: []`, and empty `fields`/`methods`/`constructors`/`nestedClasses`/`initializerBlocks`, `superClass: null`, `interfaces: []`;
  - throw `enum-body` on `(` after a constant, `{` after a constant, or any member after `;`;
  - call it from `parseCompatibilityProgram` (a top-level `isEnumDeclarationAt`) and from class bodies (nested);
  - add `EnumBody: 'enum-body'` to `UnsupportedConstruct` in `lang/hamster-lexer.js` and remove `Enum`;
  - remove `rejectUnsupportedDeclarationAt` if nothing else uses it.
- [X] T022 [US2] In `lang/hamster-runner.js`:
  - in `createRunnerState`, mark enum declarations as initialised and set the static fields to frozen enum values (N7);
  - add `invokeEnumMethod(value, name, args)` and `invokeEnumStaticMethod(declaration, name, args)` and call them from `evalCallExpressionGen` before the runtime fallback (instance call on `__kind === 'enum'`; static call on a `class` receiver whose declaration `isEnum`);
  - in the `SwitchStatement` case, resolve Identifier case tests against the discriminant's enum when the discriminant is an enum value;
  - make sure an enum declaration can't be instantiated with `new` (`Cannot instantiate enum <Name>`).
- [X] T023 [P] [US2] In `src/webview/simulator/debugger.js` `dbgFormatValue`, format `__kind === 'enum'` as `<Enum>.<NAME>` and `__kind === 'classLiteral'` as `class <Name>` (N8). Expected conformance: 920 / 0 known gaps.

## Phase 9: Gate, highlighting, docs: commit "Highlight enum and update docs for closed known gaps"

- [X] T024 Run `node scripts/conformance.cjs --min-pass-rate=1`: exit 0, 920 passed / 0 failed / 0 known gaps (SC-001, FR-011). Run `npm test` (green, < 10 s) and `npm run compile`.
- [X] T025 Deliberate-regression check: temporarily break the for-each parse; `npm test` fails and the gate exits 3; revert.
- [X] T026 [P] In `syntaxes/hamster.tmLanguage.json`, add `enum` to the `keyword.other.hamster` regex (FR-013).
- [X] T027 [P] In `.agents/skills/hamster-language/SKILL.md`, replace the known-gaps list: only `enum-body` remains tagged, plus the untagged ones (explicit generic call type arguments, `&` bounds, multi-catch unions, try-with-resources, hex literals). Note for-each over collections and the 64-bit `long` limitation in Runner gaps.
- [X] T028 [P] Update `spec/vscode-port-status.md`: the seven constructs become 🟢 with their limits (constant-only enums, arrays-only for-each, `long` as a JS number); update the Executive Summary update line to 920/920.
- [X] T029 [P] Add the entries to the `CHANGELOG.md` "Unreleased" section.
- [X] T030 Mark the tasks `[X]` in this file and record the final conformance numbers in `spec.md` under a "Results" heading.
- [ ] T031 Manual check (needs a human): F5 and run `band 2/kapitel 6/abschnitt 9/beispiel1.ham` and `beispiel2.ham` (SC-003); check `enum` highlighting; check the debugger Variables view shows `Richtung.OST`.
- [ ] T032 Push the branch and open a PR to `main`, with the per-construct commit table and conformance numbers. T031 stays unchecked in the test plan.

## Commit grouping and expected conformance

| Commit | Tasks | Passed / known gaps |
|---|---|---|
| docs (spec + tasks) | T001 | 904 / 16 |
| long literals | T003–T004 | 906 / 14 |
| several declarators | T005–T007 | 908 / 12 |
| qualified type names | T008–T010 | 911 / 9 |
| class literals + `getClass()` | T011–T013 | 915 / 5 |
| for-each | T014–T016 | 917 / 3 |
| varargs | T017–T019 | 918 / 2 |
| enum | T020–T023 | 920 / 0 |
| highlighting + docs | T024–T030 | 920 / 0 |

The counts assume each known-gap program fails only on its first construct. A program may reveal a later one: for
example, the varargs sample also needs for-each, which is why for-each comes first. If a count differs, note it
in the commit message. The passed count must never decrease.

## Dependencies

- Phases run in the listed order; all touch `lang/hamster-parser.js`, `lang/hamster-runner.js`, and `scripts/language-smoke.cjs`, so they are sequential.
- varargs (Phase 7) uses for-each (Phase 6) in its tests; enum (Phase 8) uses qualified/simple name helpers from Phase 4.
- `[P]` tasks: T023 (debugger.js) and the T026–T029 docs, which touch separate files.
