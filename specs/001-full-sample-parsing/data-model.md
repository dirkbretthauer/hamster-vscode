# Data Model: Full Sample-Program Parsing

**Feature**: [spec.md](./spec.md) | **Research**: [research.md](./research.md)

The "data" of this feature is the AST that the parser produces and the runner, diagnostics, and debugger
consume, plus the result model of the conformance check. All AST nodes follow the existing convention
`{ type, ...fields, loc: { line, column } }`. Exact syntax and field shapes are in
[contracts/ast-nodes.md](./contracts/ast-nodes.md).

## AST changes

| Node | Change | Fields | Consumers that must handle it |
|---|---|---|---|
| `TryStatement` | **changed** | `block`, `handlers: CatchClause[]`, `finalizer: Block \| null` (was a single `handler`) | runner, `collectExecutableLines` |
| `CatchClause` | **new shape** (was an anonymous object) | `paramType` (erased), `paramName`, `body`, `loc` | runner |
| `SynchronizedStatement` | **new** | `lock: Expression`, `body: Block` | runner, `collectExecutableLines`, `EXECUTABLE_STATEMENT_TYPES` |
| `InstanceofExpression` | **new** | `argument: Expression`, `targetType: string` (erased, may be qualified), `arrayDimensions: number` | runner (`evalExpressionGen`) |
| `ArrayInitializer` | **new** | `elements: (Expression \| ArrayInitializer)[]` | runner, global constant folding |
| `NewExpression` | **extended** | `initializer: ArrayInitializer \| null` (only with all-empty `dimensions`) | runner |
| `VariableDeclaration` / `FieldDeclaration` | **extended** | `initializer` may be an `ArrayInitializer` | runner, global init |
| `ClassDeclaration` / `InterfaceDeclaration` / `FunctionDeclaration` | **extended** | `typeParameters: string[]` (empty when not generic) | none at runtime (informational) |

Validation rules enforced by the parser:

- `TryStatement` MUST have `handlers.length > 0 || finalizer !== null`, otherwise an error is reported at
  `try`.
- `ArrayInitializer` is only valid as a declaration initializer, a nested element, or after `new T[]` with no
  sized dimension. `new int[3] { … }` is an error.
- `InstanceofExpression.targetType` MUST be a reference type. `x instanceof int` is an error.
- Type names stored in AST fields never contain `<…>` (erasure, research D2).

## Runtime values

No new value kinds. An `ArrayInitializer` evaluates to a plain JavaScript array, like `new T[n]`. Type
parameters such as `T` resolve like unknown reference types, so their default value is `null`.

## Try-statement outcome (runner state machine)

```text
run block ──► outcome = normal | return(v) | break | throw(e)
   │
   ├─ throw(e) and e is a language exception and a handler matches (first in order)
   │      └─► run handler with e bound ──► outcome := handler's outcome
   │
   └─► finalizer present?
          ├─ no  ──► complete with outcome
          └─ yes ──► run finalizer ──► finalizer outcome
                       ├─ normal              ──► complete with outcome
                       └─ return/break/throw  ──► complete with finalizer outcome (overrides)
```

## Parser error metadata (known gaps)

`HamsterParserError` and `HamsterLexerError` gain an optional `unsupportedConstruct` field, set only for the
out-of-scope constructs in FR-017:

| Code | Trigger | Message |
|---|---|---|
| `qualified-type-name` | a declaration whose type is `a.b.Type` | `Qualified type names are not supported` |
| `multiple-declarators` | `,` after a variable/field declarator | `Declaring several variables in one statement is not supported` |
| `enum` | `enum Name {` at top level or as a member | `enum declarations are not supported` |
| `class-literal` | `.class` after a type name | `Class literals (Foo.class) are not supported` |
| `long-literal` | an integer literal followed by `L`/`l` | `long literals are not supported` |
| `enhanced-for` | `for (Type name : …)` | `for-each loops are not supported` |

Diagnostics show these like any other error, with a precise range.

## Conformance result model

Each Java-like corpus file is classified into exactly one category:

| Category | Rule | Counts toward pass rate |
|---|---|---|
| `passed` | parses without error | yes (numerator and denominator) |
| `known-gap` | first error carries `unsupportedConstruct` | no; listed separately with its code |
| `failed` | any other error | yes (denominator only) |
| `skipped` | XML visual program or non-Java program type | no |

Pass rate = `passed / (passed + failed)`. `--min-pass-rate` applies to this rate.
