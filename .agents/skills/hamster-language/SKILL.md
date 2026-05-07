---
name: hamster-language
description: "Guides lexer, parser, runner, and syntax-highlighting changes for the Hamster (.ham) language. Use when adding keywords, operators, statements, expressions, or other language features to the hamster-vscode extension."
---

# Hamster Language – Lexer / Parser / Runner Change Guide

## Architecture Overview

The language pipeline lives in `lang/` as plain JavaScript (no build step for these files):

```
lang/hamster-lexer.js   → tokenizes .ham source into a flat token array
lang/hamster-parser.js  → recursive-descent parser producing an AST
lang/hamster-runner.js  → generator-based interpreter that walks the AST
```

Additional touchpoints when changing language features:

| File | Role |
|------|------|
| `syntaxes/hamster.tmLanguage.json` | TextMate grammar for VS Code syntax highlighting |
| `src/diagnostics.ts` | Runs the parser on-save for red-squiggle errors |
| `src/hamsterPanel.ts` | Webview runtime that bridges runner ↔ simulator UI |

## Reference Specification

The authoritative language spec is at:
`D:\Projects\hamstersimulator-v29-06-eclipse\hamstersimulator-v29-06-eclipse\hamstersimulator-2.9.6\spec\hamster-language.md`

Always read this file before implementing a feature to check exact grammar rules, semantic details, and the gap table (what the webapp already supports vs what is missing).

## Step-by-Step: Adding a Language Feature

### 1. Lexer (`lang/hamster-lexer.js`)

**When to change:** Adding new keywords, operators, or token types.

- **Keywords** – Add the word to the `KEYWORDS` Set (line ~8). The scanner already returns `TokenType.KEYWORD` for any word in this set.
- **Multi-char operators** (e.g., `+=`, `-=`, `instanceof`) – Add to `MULTI_CHAR_OPERATORS` Map. The scanner checks two-char combinations before single-char.
- **Single-char operators / symbols** – Add to `SINGLE_CHAR_OPERATORS` or `SINGLE_CHAR_TOKENS` respectively.
- **New token types** – Extend `TokenType` only if the new token doesn't fit `KEYWORD`, `OPERATOR`, or `SYMBOL`. This is rare.
- **Identifier rules** – Currently `[A-Za-z_][A-Za-z0-9_]*`. If you need `$` in identifiers, update `isIdentifierStart` and `isIdentifierPart`.

**Multi-char operator ordering matters.** The lexer tries the two-character match (`maybeTwoChar`) before falling back to single-character. If you add a three-character operator, you must extend `scanToken()` to try three chars first.

### 2. Parser (`lang/hamster-parser.js`)

**When to change:** Adding new statements, expressions, or declaration forms.

#### Adding a new statement (e.g., `switch`, `try/catch`, `break`, `throw`)

1. Add an `ASTNodeType` constant (e.g., `SwitchStatement: 'SwitchStatement'`).
2. In `parseStatement()`, add a `checkKeyword('...')` branch **before** the fallthrough to `parseExpressionStatement()`.
3. Write a `parseSwitchStatement()` (or similar) method following the pattern of `parseIfStatement()` / `parseWhileStatement()`.
4. The parser returns plain objects `{ type, ...fields, loc }`. Keep `loc: locationFrom(token)` for diagnostics.

#### Adding a new expression form (e.g., `instanceof`, `super`, type cast)

Expression parsing follows a standard **precedence-climbing** layout:

```
parseExpression → parseConditional → parseLogicalOr → parseLogicalAnd
→ parseEquality → parseRelational → parseAdditive → parseMultiplicative
→ parseUnary → parsePostfix → parsePrimary
```

- **Binary operators at existing precedence** – Add another `matchOperator(...)` call in the right `parse*()` method.
- **New precedence level** – Insert a new method in the chain and rewire the callers.
- **Prefix operators** (e.g., prefix `++`/`--`) – Add to `parseUnary()`.
- **Primary expressions** (e.g., `super`) – Add to `parsePrimary()` with `matchKeyword(...)`.
- **Postfix member/call chains** – Extend the `while(true)` loop in `parsePostfix()`.

#### Adding `instanceof` (example)

Since `instanceof` sits at the relational level (`a instanceof Foo` has the same precedence as `<`/`>`):

1. Add `'instanceof'` to `KEYWORDS` in the lexer.
2. In `parseRelational()`, add: `if (this.matchKeyword('instanceof')) { ... }` alongside the existing `<`/`>`/`<=`/`>=` checks.
3. Consume the type name and build a `BinaryExpression` node with `operator: 'instanceof'`.

#### Global variable declarations

Both parser modes support top-level (global) variable declarations like `int richtung = 0;` before or between function declarations. These are collected in `ast.globals[]` as `VariableDeclaration` nodes. The runner initializes them into the root scope before `main()` runs.

- **Normal mode**: `parseProgram()` parses globals before `main()` using `isTypeKeywordAhead()` + `isFunctionAhead()` to distinguish variables from functions.
- **Compatibility mode**: `parseCompatibilityProgram()` uses `tryParseGlobalVariable()` (checkpoint/rollback pattern) to speculatively parse globals at any position between functions.

When adding new type keywords or declaration forms, ensure `tryParseGlobalVariable()` and `isFunctionAhead()` still correctly distinguish variables from functions.

#### Compatibility mode

The parser has two entry points:
- **Normal mode** (`parseProgram`): expects global variables + `void main() { ... }` + helper functions. This is the imperative (Band 1) path.
- **Compatibility mode** (`parseCompatibilityProgram`): skips `package`/`import`, strips class/interface headers, and extracts method bodies and global variables. Used for OO programs that are "flattened" into top-level functions.

If your feature is relevant in OO programs, make sure `parseCompatibilityClassLikeDeclaration()` and `tryParseFunction()` can handle it.

#### Assignment operators (`+=`, `-=`)

The parser currently only supports `=`. To add compound assignment:
1. Add `+=` and `-=` to `MULTI_CHAR_OPERATORS` in the lexer.
2. In `parseAssignmentStatement()` and `parseForAssignment()`, extend the operator check to accept `+=` and `-=` in addition to `=`.
3. Store the operator in the `Assignment` AST node so the runner can apply the correct semantics.
4. Update `isAssignmentAhead()` to also look for `+=` and `-=` tokens.

### 3. Runner (`lang/hamster-runner.js`)

**When to change:** Any new AST node type needs an execution handler.

- **Statements** – Add a `case ASTNodeType.XxxStatement:` in `executeStatementGen()`. Follow the generator pattern: use `yield*` to delegate to sub-expressions and `yield` to emit hamster instructions.
- **Expressions** – Add a `case ASTNodeType.XxxExpression:` in `evalExpressionGen()`.
- **Global variables** – `createRunnerState()` iterates `ast.globals[]` and pre-populates the root scope. Currently only literal initializers are evaluated eagerly; complex initializers would need generator-based evaluation.
- **Compound assignment** – Modify the `case ASTNodeType.Assignment:` handler to read the current value, apply the operator, then assign.
- **String concatenation** – The `+` operator in `evalBinaryExpressionGen` currently coerces both sides to `Number`. To support `String + x`, check if either operand is a string and concatenate instead.

**Generator protocol:**
- `yield { kind: 'instruction', name, loc }` – pauses for one "step" in the UI (each hamster command is one visible step).
- `yield { kind: 'needsInput', message }` – suspends until the user provides terminal input.
- `return new ReturnSignal(value)` – propagates `return` statements up the call stack.

### 4. Syntax Highlighting (`syntaxes/hamster.tmLanguage.json`)

**When to change:** Any new keyword, operator, or built-in function should be highlighted.

- **Keywords** – Add to the appropriate `match` regex in `repository.keywords.patterns[]`. Use `keyword.control.hamster` for control flow, `keyword.other.hamster` for OO keywords, `storage.modifier.hamster` for modifiers.
- **Built-in functions** – Add to `repository.hamster-builtins.patterns[0].match`.
- **Operators** – Add to the relevant regex in `repository.operators.patterns[]`.
- **New constants** – Add to `repository.constants.patterns[]`.

### 5. Diagnostics (`src/diagnostics.ts`)

Usually no changes needed. The diagnostics system runs the parser in `{ compatibility: true, requireMain: false }` mode and surfaces any `HamsterParserError` or `HamsterLexerError` as VS Code diagnostics. As long as your parser changes throw proper errors with token location info, diagnostics will work automatically.

## Current Feature Gaps (from spec)

These features exist in the spec but are **not yet implemented**. Use this as a backlog reference:

### Lexer gaps
- `super`, `abstract`, `switch`, `case`, `default`, `break`, `try`, `catch`, `throw`, `instanceof` – not keywords
- `$` not allowed in identifiers
- `+=`, `-=` – not recognized as operators

### Parser gaps
- `switch/case/break` statement
- `try/catch/throw` statement
- Prefix `++`/`--` (only postfix is supported)
- `+=`, `-=` assignment
- `super.method()` expression
- `instanceof` expression
- Type cast `(Type) expr`
- Full class/interface/constructor/field declarations (only compatibility-mode extraction)
- `abstract` methods

### Runner gaps
- `for` statement throws at runtime (desugared to `while` by parser, but the node type is unsupported)
- Postfix `++`/`--` only works on plain identifiers (not `arr[i]++` or `this.x++`)
- String `+` concatenation (always coerces to Number)
- `super`, `instanceof`, `try/catch/throw` – not handled
- No `Territorium`/`Territory` static API
- No English alias names for built-in commands
- No concurrency (`start()`/`run()`)

## Conventions

- All three `lang/*.js` files use **ES module syntax** (`export`/`import`). They are loaded in the VS Code webview via a bundler (webpack) and in `diagnostics.ts` via `stripEsModule()` + `new Function()`.
- AST nodes are **plain objects** with a `type` string field and `loc: { line, column }` for source mapping.
- The parser uses a **checkpoint/rollback** pattern (`tryParseFunction`) for speculative parsing. Use the same pattern when adding ambiguous constructs.
- Token helpers: `matchKeyword(v)`, `matchSymbol(s)`, `matchOperator(op)`, `checkKeyword(v)`, `checkSymbol(s)`, `checkOperator(op)`, `consumeKeyword(v, msg)`, `consumeSymbol(s, msg)`, `consumeOperator(op, msg)`.
- The runner uses **JavaScript generators** (`function*`) for cooperative multitasking with the UI. Every code path in statement/expression execution must use `yield*` when delegating to sub-generators.

## Testing

There is no automated test suite yet. After making changes:
1. Build: `npm run compile`
2. Launch the extension in VS Code (F5) and open a `.ham` file.
3. Verify syntax highlighting for new tokens.
4. Verify that the parser accepts valid programs using the new feature (check the Problems panel for errors).
5. Run a `.ham` program that exercises the new feature and verify correct behavior in the simulator webview.
