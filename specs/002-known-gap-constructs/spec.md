# Feature Specification: Close the Known-Gap Java Constructs

**Feature Branch**: `speckit-002-known-gap-constructs`

**Created**: 2026-10-05

**Status**: Draft

**Input**: User description: "Close the 7 known gaps (step 1 of the plan to support more Java constructs). Reduced Spec Kit workflow: spec and tasks only."

**Workflow note**: by the user's choice, this smaller feature uses only `spec.md` and `tasks.md`. The constitution's
Constitution Check, normally part of `plan.md`, is in `tasks.md`.

## Context

Feature 001 made all 904 in-scope sample programs parse. The remaining 16 Java-like sample programs use seven
constructs that are currently rejected as known gaps (`unsupportedConstruct` codes):

| Construct | Code | Programs | How the samples use it |
|---|---|---|---|
| Class literals `Foo.class` | `class-literal` | 4 | `synchronized (Foo.class)`, `x.getClass() == Position.class`, `Foo.class.wait()` |
| Qualified type names | `qualified-type-name` | 3 | `reversi.ReversiHamster paul = new reversi.ReversiHamster();`, `java.util.Calendar c;`, `Thread.State s` |
| Several variables in one declaration | `multiple-declarators` | 2 | `MeinHamster paul = null, willi = null;` |
| for-each loops | `enhanced-for` | 2 | over an array (`Belegung[]`) and over a `HashSet` |
| `enum` declarations | `enum` | 2 | constant lists only, e.g. `enum Richtung { NORD, WEST, SUED, OST }`, compared with `==` and passed as arguments |
| `long` literals | `long-literal` | 2 | `0L`, `Thread.sleep(9223372036854775807L)` |
| varargs parameters | `varargs` | 1 | `addAll(Array<? super T> array, T... elements)` iterated with for-each |

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Every Java-like sample program parses (Priority: P1) 🎯 MVP

A student opens any of the 920 Java-like sample programs and sees no syntax errors.

**Why this priority**: it removes the last false errors on book examples, and the conformance gate can then
require all 920 programs.

**Independent Test**: `node scripts/conformance.cjs --min-pass-rate=1` reports 920 passed, 0 failed, 0 known gaps.

**Acceptance Scenarios**:

1. **Given** any of the 16 current known-gap programs, **When** it is opened, **Then** no syntax error is reported.
2. **Given** genuinely invalid uses of the new syntax (e.g. `enum E { , }`, `for (int x : ) {}`, `void f(int... a, int b)`), **When** opened, **Then** a located syntax error is reported.

---

### User Story 2 - The constructs behave as in Java (Priority: P2)

A student runs a program using these constructs and gets Java's behavior.

**Why this priority**: accepting the syntax without the behavior would only move errors from compile time to
run time.

**Independent Test**: execution smoke tests for each construct pass under `npm test`.

**Acceptance Scenarios**:

1. **Given** `enum Richtung { NORD, WEST, SUED, OST }`, **When** the program compares `r == Richtung.WEST`, passes enum values to methods, or calls `name()`, `ordinal()`, `toString()`, `Richtung.values()`, or `Richtung.valueOf("OST")`, **Then** the results match Java. The constants are distinct, each constant is a single shared instance, `values()` returns the constants in declaration order, and `ordinal()` gives their positions from 0.
2. **Given** a `switch` over an enum value with unqualified case labels (`case NORD:`), **When** it runs, **Then** the matching case runs.
3. **Given** `for (T x : array)`, **When** it runs, **Then** the body runs once per element in order, with `break`/`return` working as in other loops. Over a value that is not an array (e.g. a `HashSet`), it stops with a runtime message naming the unsupported type.
4. **Given** a method `f(int first, T... rest)`, **When** it is called with 1, 2, or more arguments, or with an array as the last argument, **Then** `rest` holds the extra arguments as an array (empty when there are none), or is the passed array itself.
5. **Given** `Foo.class`, **When** it is used as a `synchronized` lock or compared with `obj.getClass()`, **Then** `Foo.class == Foo.class`, and `obj.getClass() == Foo.class` is true exactly when `obj`'s runtime class is `Foo`.
6. **Given** `A a = null, b = new A();` (local, global, or `for` initializer), **When** it runs, **Then** both variables are declared with their own initializers, evaluated left to right.
7. **Given** `pkg.Type x = new pkg.Type();` or `java.util.Calendar c;`, **When** it runs, **Then** the type resolves by its simple name (`Type`). Unknown library types behave as before (runtime message naming the class).
8. **Given** a `long` literal such as `0L` or `9223372036854775807L`, **When** it is evaluated, **Then** it yields that number.

### Edge Cases

- An enum constant with a trailing comma (`{ NORD, WEST, }`) or a trailing `;` after the constants.
- An enum used before any of its members is accessed, nested in a class, and in a `/*class*/` file of its own.
- `valueOf` with an unknown name is a runtime error naming the enum and the name.
- for-each over `null` is a runtime error. for-each over a varargs parameter works, as in the `addAll` sample.
- A varargs parameter that is not last is a syntax error. Overloads where one candidate is varargs prefer the exact-arity method.
- `Foo.class` for a class the program does not define (e.g. `Position.class` when `Position` is missing) still gives a value, and comparisons with it are simply false.
- `long` values beyond 2^53 lose precision. This is acceptable because the samples only use them as sleep durations or bit masks that are never printed.
- `0x…` hexadecimal and other numeric literal forms stay out of scope.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The parser MUST accept `enum Name { C1, C2, … }` (optional trailing comma or `;`) at top level, as a class member, and in class files. Enums with constructors, fields, methods, or constant bodies stay out of scope and MUST report a located error naming the unsupported form.
- **FR-002**: At runtime, each enum constant MUST be a single distinct value of its enum type, with `name()`, `ordinal()`, `toString()` (the name), `equals`, and `compareTo`. The enum type MUST provide `values()` (constants in declaration order) and `valueOf(String)`.
- **FR-003**: `switch` MUST accept unqualified enum constant names as case labels when the switched value is an enum constant.
- **FR-004**: The parser MUST accept `for (Type name : expression) statement`. The runner MUST iterate arrays element by element and support `break`/`return`, and MUST fail with a message naming the type for non-array values.
- **FR-005**: The parser MUST accept a final varargs parameter `Type... name` and reject varargs in any other position. Calls MUST pack extra arguments into an array, pass an array argument in the varargs position through unchanged, and prefer exact-arity overloads.
- **FR-006**: The parser MUST accept `Name.class` (including qualified names). The runtime MUST return one canonical value per class name, and `getClass()` on objects MUST return the canonical value for their runtime class.
- **FR-007**: The parser MUST accept several declarators in one local, global, or `for` declaration. Each MUST behave as a separate declaration in order.
- **FR-008**: The parser MUST accept qualified type names in declarations, parameters, return types, casts, `instanceof`, and `new`. They MUST resolve by simple name.
- **FR-009**: The lexer MUST accept integer literals with an `L`/`l` suffix as numbers.
- **FR-010**: The `unsupportedConstruct` detection for these seven codes MUST be removed. The tagging mechanism and the conformance known-gap category MUST stay available for future gaps.
- **FR-011**: The conformance gate MUST report 920 passed / 0 failed / 0 known gaps, and all 904 programs passing before MUST still pass.
- **FR-012**: Each construct MUST have smoke-test coverage for parsing and for its runtime behavior (FR-002 to FR-009), and existing tests for the old known-gap errors MUST be replaced.
- **FR-013**: Syntax highlighting MUST cover `enum`. The skill gap list, `spec/vscode-port-status.md`, and `CHANGELOG.md` MUST be updated.

## Success Criteria *(mandatory)*

- **SC-001**: 920 of 920 Java-like sample programs parse (up from 904, plus 16 known gaps).
- **SC-002**: Zero regressions: all 904 previously passing programs still pass, and the full test suite stays under 10 seconds.
- **SC-003**: The two enum samples (`band 2/kapitel 6/abschnitt 9/beispiel1.ham`, `beispiel2.ham`) run to completion in the simulator. The varargs/for-each sample folder (`band 2/kapitel 15/beispielprogramm 2`) contains only class files and no `main`, so its `Arrays.addAll` behavior is covered by an execution smoke test modelled on it.

## Assumptions

- Enums are limited to plain constant lists, which is all the samples use. Richer enums would be a later feature.
- for-each over collections depends on the planned `java.util` subset (step 3) and is out of scope here.
- Running these programs to completion can still be blocked by threads or library classes. Those remain separate gaps (steps 2 and 3), so SC-003 names only samples that need neither.
- Java numbers are modelled as JavaScript numbers. `long` is not given 64-bit integer semantics.
