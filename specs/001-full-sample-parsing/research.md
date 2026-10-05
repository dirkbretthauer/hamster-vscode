# Research: Full Sample-Program Parsing

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Date**: 2026-10-05

This file records the decisions needed to turn the spec into a design. The sample corpus (`<reference>/Programme`)
was surveyed with comments and strings stripped. Counts are numbers of Java-like programs that contain each
pattern.

## Corpus survey

| Pattern | Programs | Consequence |
|---|---|---|
| `synchronized` modifier | 32 | modifier support needed |
| `synchronized (…)` block | 29 | statement support needed; some locks are `Foo.class` (out of scope, FR-017) |
| `wait`/`notify` calls | 27 | runtime only: these programs parse but need threads (FR-014) |
| Thread usage (`extends Thread`, `.start()`) | 103 | runtime only (FR-014) |
| Wildcard `<? super T>` | 1 | wildcards needed |
| Generic method `static <T> void …` | 1 | method type parameters needed |
| Nested type args closing with `>>` | 1 | `>>` must close two levels |
| Bounded type params / `&` bounds / diamond `<>` / `.<T>call()` | 0 | supported cheaply (bounds, diamond) or not at all (`&`, explicit call type args) |
| `finally` | 8 | needed |
| Multi-catch union `catch (A \| B e)` / try-with-resources | 0 | not needed |
| `instanceof` | 5 | needed |
| `= { … }` array initializer | 5 | needed; all are flat `boolean[]` fields |
| `new T[] { … }` / nested `{ { … } }` | 0 | supported for completeness because it costs little; corpus doesn't need it |
| `new ArrayList/HashMap/HashSet…` | 12 | parse only: runtime library is out of scope (FR-014) |

## Decisions

### D1. Distinguishing type arguments from `<` comparisons

- **Decision**: Recognise type arguments only in *type positions*. The parser gets a non-consuming scanner,
  `scanTypeArgumentsEnd(index)`, which returns the index after a balanced `<…>` whose contents are only type
  tokens: identifiers, `.`, `,`, `?`, `extends`, `super`, `int`, `boolean`, `[`, `]`, and nested `<…>`.
  Otherwise it returns -1. The type positions are:
  1. after a type name in declarations (`isTypeKeywordAhead`, `isFunctionAhead`, `tryParseGlobalVariable`,
     `consumeTypeName`);
  2. after the class name in `new` expressions;
  3. inside casts (`isCastAhead`);
  4. in `extends`/`implements`/`throws` clauses (`consumeQualifiedName`);
  5. type parameters after a class/interface name and before a method's return type.
- **Rationale**: Expression parsing never has to guess, so `a < b`, `i < n && j > m` and `x < y == z` keep their
  meaning without backtracking. Every declaration-detection helper already uses token lookahead, so it only needs
  to skip a balanced type-argument span.
- **`>>`**: the lexer has no shift operators, so `>>` already arrives as two `>` tokens and needs no special case.
  `>=` immediately after type arguments (`List<T>= x`) does not occur and stays unsupported.
- **Alternatives considered**: (a) Speculatively parse every `<` as type arguments, rolling back on failure. This
  is expensive, and `a < b > c` is ambiguous. (b) Lex `<`/`>` differently in type context. The lexer has no
  context, so this was rejected.

### D2. Representation of generics in the AST

- **Decision**: Erase at parse time. Type strings in the AST (`varType`, `paramType`, `returnType`, `superClass`,
  `interfaces`, catch types, cast `targetType`, `new` callee) hold the base name only, e.g. `Speicher` for
  `Speicher<Integer>`. Declared type parameters are recorded as `typeParameters: string[]` on class, interface,
  and method nodes for diagnostics and future use. Type arguments themselves are not kept.
- **Rationale**: FR-012 requires erasure, and every runtime lookup (class instantiation, `catch` matching, casts,
  `instanceof`) already works by base name. A type variable such as `T` used as a field or parameter type behaves
  like an unknown reference type and defaults to `null`, which is correct for Java.
- **Alternatives considered**: keeping the full type-argument tree in the AST. No consumer needs it (YAGNI, per
  constitution Principle VI).

### D3. `synchronized`

- **Decision**: Add `synchronized` to the lexer keywords and to the single modifier list. `isFunctionAhead`
  currently duplicates that list; it will reuse `isModifierToken`. Add a `SynchronizedStatement { lock, body }`
  node. The runner evaluates `lock`, rejects a `null` lock like Java does (NullPointerException-style runtime
  error), then executes `body` once.
- **Rationale**: FR-001/002/013. The runner is single-threaded (one generator), so mutual exclusion holds
  trivially. The lock is evaluated for side effects and the null check.
- **Alternatives considered**: treating the block as a plain block during parsing (no new node). Rejected because
  it would skip lock evaluation and the debugger's executable-line entry for the `synchronized` line.

### D4. `try` with multiple `catch` and `finally`

- **Decision**: Change the AST from `handler` to `handlers: CatchClause[]` (possibly empty) plus
  `finalizer: Block | null`. The parser requires at least one handler or a finalizer. The runner implements the
  semantics explicitly instead of using a JavaScript `finally`:
  1. Run `block`, capturing either its result (normal completion, `ReturnSignal`, or `BreakSignal`) or a thrown
     error.
  2. If an error was thrown and is a `HamsterLanguageException`, the first handler whose type matches
     (`exceptionMatchesType`) runs. Its outcome then replaces the captured one.
  3. If there is a finalizer, run it. If it completes abruptly (a control signal or a throw), that outcome wins.
     Otherwise the captured outcome is returned or re-thrown.
- **Rationale**: FR-008/009. A JavaScript `finally` around `yield*` would also run user code when a generator is
  closed with `.return()`, which `evaluateExpression` does when it cleans up debugger evaluations. Explicit
  outcome capture avoids running hamster code during cleanup. The finalizer also runs for non-language runtime
  errors (e.g. null dereference), because those correspond to Java runtime exceptions.
- **Alternatives considered**: desugaring `finally` into duplicated code on every exit path. Rejected as complex
  and error-prone for `return`/`break`.

### D5. `instanceof`

- **Decision**: Add `instanceof` to the lexer keywords. Parse it in `parseRelational` as
  `InstanceofExpression { argument, targetType, arrayDimensions }`; the right-hand side is a type, not an
  expression. At runtime:
  - `null` gives `false`, and `Object` gives `true` for any non-null value.
  - Arrays match only when `arrayDimensions > 0`.
  - JavaScript strings match `String`.
  - Typed objects use the `isAssignableToType` hierarchy walk that casts already use (superclass, interfaces,
    built-in exception chain, native `*Hamster` → `Hamster`).
  - Anything else gives `false`.
- **Rationale**: FR-006/010, and reusing the cast helpers keeps the hierarchy logic in one place.
- **Alternatives considered**: `BinaryExpression` with operator `instanceof`. Rejected because its right operand
  would have to be a fake expression node.

### D6. Array initializers

- **Decision**: Add an `ArrayInitializer { elements }` node (elements may be nested initializers). It is accepted:
  - as the initializer of variable, field, `for`, and global declarations, via one shared
    `parseVariableInitializer()` helper;
  - after `new T[]…[]` with only empty dimensions, stored as `NewExpression.initializer`.

  Trailing commas and `{}` are allowed. The runner evaluates elements left to right into a JavaScript array.
- **Globals**: `createRunnerState` only evaluates literal global initializers today, which is a known separate
  gap. An `ArrayInitializer` whose leaves are all literals is constant-folded in the same way. Non-constant global
  initializers stay as they are.
- **Rationale**: FR-007/011. One helper avoids four copies of the `= …` logic. All corpus uses are flat literal
  `boolean[]` fields, so they work through both instance-field initialisation and constant folding.
- **Alternatives considered**: evaluating every global initializer through the generator at program start. That
  is a broader behaviour change (it can execute hamster instructions before `main`) and belongs in its own
  feature.

### D7. Out-of-scope constructs report targeted errors (known gaps)

- **Decision**: The parser detects the six out-of-scope constructs and throws a `HamsterParserError` carrying an
  `unsupportedConstruct` code and a clear message, such as "enum declarations are not supported". The codes are:
  `qualified-type-name`, `multiple-declarators`, `enum`, `class-literal`, `long-literal`, and `enhanced-for`.
  `long-literal` is raised by the lexer as a `HamsterLexerError` with the same field. The conformance script
  classifies any failure carrying `unsupportedConstruct` as a *known gap* rather than a regression.
- **Rationale**: FR-017 needs known gaps to be reported separately, and doing it in the parser is precise. Regex
  scanning of the source would be fragile around comments and strings. Students also get an accurate message
  instead of "Expected member name".
- **Limitation**: a known-gap program could hide an in-scope failure later in the same file. This is acceptable
  because the count is small (~10) and the list is printed for review.
- **Alternatives considered**: a hard-coded list of known-gap files in the script. Rejected because it would go
  stale and hide new regressions in those files.

### D8. Runtime messages for unsupported library classes and threads

- **Decision**: In the simulator runtime adapter (`src/webview/simulator/runtime.js`), method calls on generic
  runtime objects of unknown classes fail with a message that names the class, e.g.
  "`ArrayList.add`: class ArrayList is not provided by the Hamster simulator". `start`, `run`, `join`, `wait`,
  `notify`, and `notifyAll` on hamsters and objects fail with "Hamster threads (start) are not supported".
- **Rationale**: FR-014 asks for an actionable message naming the class or feature. The current message is the
  generic "Unsupported method call: add".

### D9. Validation strategy

- **Decision**:
  - `scripts/language-smoke.cjs` gets parse tests for every construct and variant in the edge-case list, plus
    execution tests for `finally`, multiple `catch`, `instanceof`, initializers, erasure, and `synchronized`
    (FR-018).
  - `collectExecutableLines` tests cover the new statement shapes.
  - `scripts/conformance.cjs` gets a known-gaps section, and `--min-pass-rate` is applied to the in-scope set
    (FR-019).
  - The target command is `npm run conformance -- --min-pass-rate=1`.
- **Rationale**: the in-repo tests stand on their own without the corpus (spec assumption); the corpus gate
  proves SC-001/SC-002.

### D10. Syntax highlighting

- **Decision**: Add `finally` to `keyword.control`, `instanceof` to `keyword.operator`, and `synchronized` to
  `storage.modifier` in `syntaxes/hamster.tmLanguage.json` (FR-020).

## Baseline

- 2026-10-05, before implementation: `node scripts/conformance.cjs` reports TOTAL 808 passed / 112 failed of 920 Java-like programs (87.8%).
