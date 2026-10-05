# Changelog

## Unreleased — Full Sample-Program Parsing

- All 920 Java-like sample programs of the reference Hamster Simulator now parse without false errors
- Formerly unsupported constructs now work:
  - constant-only `enum`s with `values()`, `valueOf()`, `name()`, `ordinal()`, and `switch` over enum constants
  - for-each loops over arrays
  - varargs parameters (`int... values`)
  - class literals `Foo.class` and `getClass()`
  - several variables in one declaration (`A a = null, b = null;`)
  - qualified type names (`java.util.Calendar c`, `new pkg.Type()`), resolved by simple name
  - `long` literals (`0L`), as plain numbers
- Enums with constructors, fields, or methods still report a clear "not supported" error
- New language support:
  - generics (type arguments, wildcards, generic classes/interfaces/methods; erased at runtime)
  - `synchronized` methods and blocks
  - `try` with several `catch` clauses and `finally`
  - `instanceof`
  - array initializers (`{ 1, 2 }`, `new int[] { … }`)
- Runtime errors now name the missing Java library class (e.g. `ArrayList`) or say that hamster threads are not supported
- Syntax highlighting for `finally`, `instanceof`, `synchronized`, and `enum`
- `npm run conformance` reports known gaps separately and can require a 100% in-scope pass rate

## 0.4.0 — Compile Button & Debugger Integration

- Added a **Compile** button to the simulator toolbar (left of Run) that validates the current `.ham` file and reports errors with line/column information
- Parser gained a `strict` option that surfaces previously-swallowed top-level garbage (e.g. malformed function declarations next to a valid `void main()`); the Compile button uses it
- Added full **VS Code debugger** integration for `.ham` files (press F5)
  - Breakpoints in the editor gutter
  - Step over / step in / step out, continue, pause
  - Call stack showing nested user-function calls
  - Variables view with Locals (current frame) and Globals
  - Hover and watch expressions for identifiers
  - Program output routed to the Debug Console
- Runner now tracks call frames (`state.frames`) to support stack traces

## 0.3.0 — Global Variable Support

- Added support for top-level (global) variable declarations in imperative programs (e.g., `int richtung = 0;` before `void main()`)
- Parser now collects globals in both normal and compatibility modes
- Runner initializes global variables into the root scope before `main()` executes

## 0.2.0 — Web Extension Support

- Migrated to VS Code web extension — now runs in vscode.dev and github.dev
- Replaced Node.js `fs`/`path` APIs with `vscode.workspace.fs` and `vscode.Uri`
- Added webpack bundling for `webworker` target
- Fully compatible with desktop VS Code as well

## 0.1.0 — Initial Release

- Syntax highlighting for `.ham` files (Java-like Hamster language)
- Simulator panel with Run, Step, Stop, and Reset controls
- Canvas-based terrain rendering with hamster, walls, and corn
- Step debugging with editor line highlighting
- Custom terrain editor for `.ter` files with wall, corn, and hamster placement tools
- Real-time parse error diagnostics
