# Feature Specification: Full Sample-Program Parsing

**Feature Branch**: `001-full-sample-parsing`

**Created**: 2026-10-05

**Status**: Draft

**Input**: User description: "I want to fully support the sample programs by the parser. The current failures regarding Generics, synchronized, finally, instanceof, array initializers and multiple catch should be fixed. Validate with a test"

## Context

The reference Hamster Simulator ships about 950 sample programs, the examples from the Hamster books (Band 1–3).
920 of them are written in the Java-like Hamster language that this extension supports. Today the extension accepts
808 of those (87.8%). The other 112 show false syntax errors and cannot be run. Students who open a book example
therefore see red squiggles on code that is correct in the original simulator.

Breakdown of the 112 failing programs by the first unsupported construct each one hits (one program can contain
several):

| Construct | Programs |
|---|---|
| `synchronized` (method modifier and `synchronized (…) { … }` block) | ~47 |
| Generics (type arguments, generic classes/interfaces/methods, wildcards) | ~34 |
| `try … finally` | 7 |
| `instanceof` | 5 |
| Array initializers (`{ false, false }`) | 5 |
| Multiple `catch` clauses | 4 |
| Out of scope (FR-017): qualified type names (`java.util.Calendar x`), several variables in one declaration, `enum`, class literals (`Foo.class`), `long` literals (`0L`), for-each loop | ~10 |

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Open book examples without false errors (Priority: P1)

A student opens any Java-like sample program from the Hamster books in VS Code. The editor shows no syntax errors
for code the original simulator accepts, and the Compile button reports success.

**Why this priority**: False errors on official examples are the most visible defect. They undermine trust in
the tool and block every later step (running, stepping, debugging).

**Independent Test**: Open sample programs that use each listed construct and confirm that the Problems panel is
empty and Compile succeeds. Across the whole corpus, the repeatable conformance check reports every in-scope
program as accepted.

**Acceptance Scenarios**:

1. **Given** a sample class declaring `synchronized void put(…)` and a `synchronized (lock) { … }` block, **When**
   the student opens it, **Then** no syntax error is reported.
2. **Given** a sample using `Speicher<Integer> kacheln = new Speicher<Integer>();`, `class Pair<K, V>`, and
   `Array<? super T>`, **When** the student opens it, **Then** no syntax error is reported.
3. **Given** a sample with `try { … } catch (A a) { … } catch (B b) { … } finally { … }`, **When** the student
   compiles it, **Then** compilation succeeds.
4. **Given** a sample with `if (hamster[i] instanceof BeuteHamster)` and
   `private boolean[] kritisch = { false, false };`, **When** the student opens it, **Then** no syntax error is
   reported.
5. **Given** a program with a genuine syntax error near one of these constructs (e.g. a missing `}` after a
   `finally` block), **When** the student opens it, **Then** an error is still reported at the correct line.

---

### User Story 2 - Run programs using exceptions, type tests, and array literals (Priority: P2)

A student runs or steps through a sample that uses `finally`, multiple `catch` clauses, `instanceof`, or array
initializers. The program behaves as it does in the original simulator.

**Why this priority**: Accepting the syntax without the matching behavior would turn compile-time errors into
confusing runtime failures. These four constructs have clear, well-known semantics that the book teaches
explicitly (Band 2, chapters 11–13).

**Independent Test**: Run small programs that use each construct and compare the observable outcome (hamster
moves, printed output, variable values) with the original simulator's documented behavior.

**Acceptance Scenarios**:

1. **Given** a `try` block that throws, **When** it runs, **Then** the first `catch` clause whose type matches
   handles the exception, later clauses are skipped, and the `finally` block runs afterwards.
2. **Given** a `try` block that completes normally, returns, or breaks out of a loop, **When** it runs, **Then**
   the `finally` block runs before control leaves the `try` statement.
3. **Given** an exception that no `catch` clause matches, **When** it runs, **Then** the `finally` block runs and
   the exception continues to propagate.
4. **Given** `x instanceof T`, **When** it is evaluated, **Then** the result is `true` exactly when `x` is a
   non-null object whose class is `T` or a subclass or implementation of `T`.
5. **Given** `int[] a = { 1, 2, 3 };` or `new int[] { 1, 2, 3 }` (including nested `{ {1, 2}, {3} }`), **When** it
   runs, **Then** the array holds exactly those elements in that order.

---

### User Story 3 - Run programs using generics and synchronized (Priority: P3)

A student runs a sample that declares its own generic classes or uses `synchronized`. The program runs as far as
the extension's single-hamster-thread model allows.

**Why this priority**: Generics and `synchronized` cover the most programs (User Story 1), but at runtime they
mostly constrain types and locking. Neither changes the result of single-threaded execution, so their runtime
value is lower than that of User Story 2.

**Independent Test**: Run a sample with a user-defined generic container (e.g. `Speicher<T>`) and a sample with
`synchronized` methods/blocks in a single-threaded flow, and confirm that they produce the same results as their
non-generic or unsynchronized equivalents.

**Acceptance Scenarios**:

1. **Given** a user-defined generic class used with different type arguments, **When** the program runs,
   **Then** it behaves identically to the same program with the type arguments removed.
2. **Given** a `synchronized` method or block, **When** it runs, **Then** its body executes exactly once per entry,
   and the lock expression of a block is evaluated.
3. **Given** a program that parses but depends on a Java library class the extension does not provide (e.g.
   `ArrayList`, `HashSet`) or on starting hamster threads, **When** it runs, **Then** it stops with a clear
   runtime message that names the unsupported class or feature, rather than a syntax error.

---

### User Story 4 - Guard against regressions (Priority: P4)

A maintainer changing the language tools needs fast confirmation that every supported sample program is still
accepted and that each new construct still behaves correctly.

**Why this priority**: This is the "validate with a test" part of the request. It keeps the result from eroding,
but delivers no value until Stories 1–3 exist.

**Independent Test**: Run the project's automated tests and the corpus conformance check. Then deliberately break
one construct and confirm that both catch it.

**Acceptance Scenarios**:

1. **Given** the reference corpus is available, **When** the conformance check runs with a required pass rate of
   100% for in-scope programs, **Then** it succeeds; **and When** any in-scope program stops parsing, **Then** it
   fails and names the program.
2. **Given** the repository alone (no reference corpus), **When** the automated test suite runs, **Then** each
   listed construct is covered by at least one parsing test and, for Story 2 constructs, at least one execution
   test.

### Edge Cases

- **Generics vs. comparison**: `a < b`, `i < n && j > m`, and `x < y == z` must keep their comparison meaning.
  Only type positions are read as type arguments.
- **Nested generics**: `Map<String, List<Integer>>` closes with `>>`, which must not be read as a shift operator
  or a parse error.
- **Generic forms**: wildcards (`?`, `? extends T`, `? super T`), bounded type parameters (`<T extends Hamster>`),
  generic methods (`public static <T> void replace(…)`), and generic interface implementation
  (`implements Callable<Integer>`).
- **`finally` control flow**: a `return` or thrown exception inside `finally` replaces the outcome of the `try`
  block, as in Java. `try … finally` without any `catch` is valid.
- **Catch ordering**: when an earlier `catch` clause's type is a supertype of a later one, the earlier clause wins.
- **`instanceof` precedence**: `a instanceof B && c` and `!(a instanceof B)` group as in Java. `null instanceof T`
  is `false`.
- **Array initializers**: an empty `{}`, a trailing comma (`{ 1, 2, }`), use in field and local declarations, and
  use as `new T[] { … }` in expressions.
- **`synchronized` placement**: as a modifier combined with others in any order (`synchronized static`,
  `public synchronized`), and as a block whose lock is any expression. A `Foo.class` lock remains a known gap
  (FR-017).
- **Diagnostics stay precise**: malformed uses of the new syntax (e.g. `catch` without a parameter, unclosed `<`)
  report a located error instead of being silently skipped.

## Clarifications

### Session 2026-10-05

- Q: What counts as "fully support" — all 920 Java-like samples, or only the six requested constructs? → A: Only
  the six requested constructs (option B). Programs using other unsupported constructs are known gaps (FR-017).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The parser MUST accept `synchronized` as a method modifier, in any order with the other modifiers.
- **FR-002**: The parser MUST accept `synchronized (expression) block` as a statement.
- **FR-003**: The parser MUST accept generic type usage wherever a type can appear: in variable, field, parameter,
  and return types, in `new` expressions, in casts, and in `extends`/`implements` clauses. This includes nested
  type arguments and wildcards.
- **FR-004**: The parser MUST accept type parameter declarations on classes, interfaces, and methods, including
  bounds.
- **FR-005**: The parser MUST accept `try` statements with one or more `catch` clauses, an optional `finally`
  block, or both, and MUST reject a `try` that has neither.
- **FR-006**: The parser MUST accept `expression instanceof Type` at relational-operator precedence.
- **FR-007**: The parser MUST accept array initializers in variable and field declarations and after
  `new Type[]`, including nested initializers.
- **FR-008**: Execution MUST follow Java semantics for multiple `catch` clauses: clauses are checked in order and
  the first matching type wins.
- **FR-009**: Execution MUST run the `finally` block on every exit path from the `try` statement (normal
  completion, `return`, `break`, caught or uncaught exception). A `return` or exception from `finally` overrides
  the earlier outcome.
- **FR-010**: Execution MUST evaluate `instanceof` using the class, superclass, and interface hierarchy already
  used for casts and `catch` matching, and MUST return `false` for `null`.
- **FR-011**: Execution MUST create arrays from initializers with exactly the listed elements, including nested
  arrays.
- **FR-012**: Execution MUST treat type arguments and type parameters as having no runtime effect (erasure).
- **FR-013**: Execution MUST run a `synchronized` block's lock expression and body once per entry. Because the
  extension runs a single hamster thread, no actual locking takes place.
- **FR-014**: A program that parses but uses a Java library class or threading feature the extension does not
  implement MUST fail at runtime with a message naming that class or feature.
- **FR-015**: Syntax errors in or around the new constructs MUST still be reported with line and column, and
  previously reported error kinds MUST NOT disappear for genuinely invalid code.
- **FR-016**: Every one of the 808 sample programs accepted before this feature MUST still be accepted.
- **FR-017**: The scope is limited to the six requested constructs. Qualified type names, several variables in one
  declaration, `enum`, class literals (`Foo.class`), `long` literals (`0L`), and the for-each loop are out of scope.
  Varargs parameters (`T... xs`) are out of scope too. They surfaced during implementation in one sample
  (`band 2/kapitel 15/beispielprogramm 2/Arrays.ham`) and are not among the six requested constructs.
  Sample programs that use any of them are excluded from the in-scope set and recorded as remaining known gaps
  (FR-021). The conformance check MUST report these programs separately from regressions, so that a 100% gate on the
  in-scope set does not fail because of them.
- **FR-018**: The automated test suite MUST include, for each requested construct, at least one test that parses
  a representative snippet. For each construct with runtime behavior (FR-008 to FR-013), it MUST also include at
  least one test that checks the execution result.
- **FR-019**: The corpus conformance check MUST be able to require a 100% pass rate for the in-scope programs and
  fail when any of them regresses.
- **FR-020**: Syntax highlighting MUST recognize the new keywords (`synchronized`, `finally`, `instanceof`).
- **FR-021**: The project's list of known language gaps and its conformance status document MUST be updated to
  reflect the newly supported constructs and any that remain out of scope.

### Key Entities

- **Sample program corpus**: the reference simulator's Java-like example programs (920 files), grouped as
  imperative, object-oriented, and class programs. It is the yardstick for "fully supported".
- **In-scope program**: a Java-like corpus program that uses none of the out-of-scope constructs listed in FR-017
  (roughly 910 of the 920). The success criteria are measured against this set.
- **Known-gap program**: a Java-like corpus program that uses at least one out-of-scope construct (roughly 10).
  It is reported, but not counted as a failure of this feature.
- **Construct**: one language feature from the breakdown table. Each construct has parse acceptance criteria and,
  where applicable, runtime behavior criteria.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of in-scope sample programs (roughly 910 of 920) are accepted without syntax errors, up from
  87.8% of all Java-like samples today. The roughly 10 known-gap programs are listed by the conformance check,
  each with the out-of-scope construct it uses.
- **SC-002**: All 808 previously accepted sample programs remain accepted (zero regressions).
- **SC-003**: For each of the six requested constructs, at least one sample program runs to completion with the
  same observable result (hamster position, corn counts, printed output) as in the original simulator. Programs
  that need unimplemented library classes or threads are excluded.
- **SC-004**: The full automated test suite, including the new construct tests, still completes in under 10
  seconds on a developer machine, so it stays practical to run on every change.
- **SC-005**: Introducing a deliberate parse regression in any requested construct makes at least one automated
  check fail.

## Assumptions

- "Fully support … by the parser" means primarily that sample programs parse. Where a construct has runtime
  meaning, it also executes correctly (Stories 2–3). Otherwise parsed-but-unrunnable programs would only move the
  error from compile time to run time.
- Java standard library classes (`ArrayList`, `HashMap`, `HashSet`, `Thread`, `Calendar`, …) and concurrent
  hamster threads (`start()`/`run()`) remain out of scope. Programs that rely on them will parse but cannot run to
  completion (FR-014).
- Generic types are checked for syntax only. No compile-time type checking of type arguments is performed,
  matching the extension's existing lenient handling of types.
- The Java reference sources are the authority on semantics (per the constitution, Principle I), and the Java
  language rules for `finally`, `catch`, and `instanceof` apply where the Hamster sources don't redefine them.
- The ~30 non-Java samples (Scheme, Prolog, Python, JavaScript, Ruby, and visual XML programs) stay out of scope.
- The corpus conformance check depends on the reference corpus being present locally. The in-repository
  automated tests must stand on their own without it.
