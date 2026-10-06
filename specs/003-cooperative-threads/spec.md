# Feature Specification: Cooperative Hamster Threads

**Feature Branch**: `003-cooperative-threads`

**Created**: 2026-10-06

**Status**: Draft

**Input**: User description: "I want that the hamster supports cooperative threads."

## User Scenarios & Testing *(mandatory)*

In the reference Hamster Simulator, a hamster *is* a thread: Band 3, chapters 10-12 of the
course material teach concurrency by letting several hamsters act at the same time in one
terrain. Today this extension runs every program strictly sequentially, so those teaching
programs either do nothing (a started hamster never moves) or produce misleading results.
This feature makes concurrent hamster programs runnable, observable, and debuggable.

### User Story 1 - Several hamsters act at the same time (Priority: P1)

A student writes a program that creates two or more hamster objects, overrides each one's
behaviour, and starts them. Both hamsters then move around the same terrain in an interleaved
fashion, visibly taking turns, until each has finished its own task. The program only finishes
once every started hamster has finished.

**Why this priority**: This is the entry point of the whole topic (chapter 10.1/10.2). Without
it, no concurrency program produces any visible behaviour at all. On its own it already turns
a large group of currently-dead sample programs into working demonstrations.

**Independent Test**: Run a program that starts two grain-eating hamsters on a terrain with
grain in two different places and observe both hamsters moving and collecting grain in the
simulator, with the program ending after both are done.

**Acceptance Scenarios**:

1. **Given** a program that creates two hamsters and starts both, **When** the program runs,
   **Then** both hamsters perform their actions interleaved in the simulator, and neither
   hamster waits for the other to finish first.
2. **Given** a started hamster whose behaviour has not been overridden, **When** the program
   runs, **Then** the hamster does nothing and finishes immediately without an error.
3. **Given** a hamster that has already been started, **When** the program starts it a second
   time, **Then** the program reports a clear error naming the problem and its source location.
4. **Given** a program whose main part has finished while started hamsters are still working,
   **When** the remaining hamsters finish, **Then** the program is reported as finished - not
   earlier.
5. **Given** a running concurrent program, **When** the user presses Stop or Reset,
   **Then** every running hamster stops immediately and the simulator returns to a clean state.

---

### User Story 2 - Mutual exclusion over shared terrain (Priority: P2)

A student protects a shared resource - a shared counter, a narrow bridge, a tile both hamsters
want - so that only one hamster at a time may use it. While one hamster holds the protected
section, the others wait at its entrance and continue as soon as it is released.

**Why this priority**: Chapter 11/12 exercises exist precisely to show that unprotected shared
access goes wrong and that protection fixes it. Without real mutual exclusion, "protected" and
"unprotected" versions of the same program behave identically and the lesson is lost.

**Independent Test**: Run the classic "both hamsters increment a shared counter" program in its
protected form and verify the final count is exactly right, repeatedly.

**Acceptance Scenarios**:

1. **Given** two hamsters calling a protected section guarded by the same object, **When** they
   run concurrently, **Then** at most one hamster is inside that section at any time.
2. **Given** a hamster already inside a protected section guarded by an object, **When** the same
   hamster enters another section guarded by the same object, **Then** it is allowed in and the
   section is only released once it has left both.
3. **Given** protection attached to a class rather than an object, **When** several hamsters of
   that class enter it, **Then** they exclude one another across all instances of that class.
4. **Given** a hamster waiting at the entrance of a protected section, **When** the holder
   leaves it, **Then** exactly one waiting hamster is let in.

---

### User Story 3 - Hamsters wait for and signal each other (Priority: P3)

A student builds a semaphore, a producer/consumer buffer, or a dining-philosophers solution:
a hamster that cannot proceed releases the protected section and suspends itself until another
hamster signals that the situation has changed, then re-checks its condition and continues.

**Why this priority**: This completes the course material (chapters 11.2-11.4 and 12) and covers
the largest and most intricate group of reference programs. It depends on User Story 2 being in
place, so it follows it.

**Independent Test**: Run a producer/consumer program with a bounded buffer and verify no grain
is lost or duplicated and that neither side overruns the buffer, with both hamsters visibly
taking turns when the buffer is full or empty.

**Acceptance Scenarios**:

1. **Given** a hamster that suspends itself inside a protected section, **When** it suspends,
   **Then** it gives up that protected section so another hamster can enter it.
2. **Given** a suspended hamster, **When** another hamster signals the same object,
   **Then** the suspended hamster becomes runnable again and only continues once it has
   re-acquired the protected section.
3. **Given** several suspended hamsters, **When** a hamster signals all of them,
   **Then** all of them become runnable again and proceed one after another.
4. **Given** a hamster that tries to suspend itself or signal without holding the corresponding
   protected section, **When** it does so, **Then** the program reports a clear error naming the
   problem and its source location.
5. **Given** a program in which every hamster is permanently blocked waiting for the others,
   **When** no hamster can make progress any more, **Then** the user is told the program is
   stuck rather than being left with a silently frozen simulator.

---

### User Story 4 - Control the lifetime of helper hamsters (Priority: P4)

A student sends helper hamsters out to search, then waits for them to report back, cancels them
when the answer is found, lets them pause for a while, or marks them as helpers that must not
keep the program alive once the main work is done.

**Why this priority**: These controls (chapters 10.3-10.5) appear in fewer programs than the
core concurrency and synchronisation features, and the earlier stories are usable without them.

**Independent Test**: Run the "info hamster sends two helpers in opposite directions" program and
verify the main hamster resumes as soon as the first helper reports success and that the other
helper does not keep the program running.

**Acceptance Scenarios**:

1. **Given** a hamster waiting for another hamster to finish, **When** that other hamster
   finishes, **Then** the waiting hamster resumes.
2. **Given** a hamster that is pausing, waiting for another hamster, or suspended,
   **When** it is cancelled, **Then** it wakes up, is told it was cancelled, and can react to it.
3. **Given** a hamster marked as a helper that must not keep the program alive, **When** every
   non-helper hamster has finished, **Then** the program finishes and the helper is stopped.
4. **Given** a hamster asked to pause for a given duration, **When** the simulation is paused or
   the user steps through the program, **Then** the pause does not advance, and it resumes
   advancing when the simulation resumes.
5. **Given** a hamster that is asked to terminate abruptly, **When** it terminates,
   **Then** any protected sections it held are released so other hamsters are not stuck.

---

### User Story 5 - Observe and debug a concurrent program (Priority: P5)

A teacher steps through a concurrent program to show students the interleaving: which hamster
acted last, what each hamster is currently doing, and where each one is waiting.

**Why this priority**: Concurrency is only teachable if it is observable, but the earlier stories
deliver working programs on their own; observation tooling refines them.

**Independent Test**: Set a breakpoint inside a hamster's behaviour in a two-hamster program and
verify execution stops there, that the call stacks and variables of each hamster can be
inspected separately, and that resuming continues the interleaving.

**Acceptance Scenarios**:

1. **Given** a running concurrent program, **When** the user looks at the simulator,
   **Then** it is apparent which hamster performed the most recent action.
2. **Given** a breakpoint inside a hamster's behaviour, **When** any hamster reaches it,
   **Then** the whole program stops and every live hamster is listed separately, each with its
   own call stack and variables.
3. **Given** a stopped concurrent program, **When** the user selects a hamster that is waiting,
   **Then** the user can see its call stack, that it is waiting, and what it is waiting for.
4. **Given** a stopped concurrent program with a hamster selected, **When** the user steps,
   **Then** that hamster advances by one step and the simulator makes clear which one acted.
5. **Given** a stopped concurrent program, **When** a hamster finishes or a new one is started
   after resuming, **Then** the list of hamsters reflects that at the next stop.

---

### Edge Cases

- A hamster is started twice, or started while it is already running -> clear, located error.
- A started hamster has no overridden behaviour -> it finishes immediately, no error.
- A hamster's behaviour throws an uncaught error -> that hamster terminates with a message naming
  the error; other hamsters keep running (matching the reference simulator).
- Every hamster becomes permanently blocked (deadlock, or all suspended with no possible
  signaller) -> the user is told the program is stuck, with the state of each hamster.
- A hamster never terminates (e.g. an endless search loop) -> the program keeps running until the
  user stops it; the existing runaway-loop safeguards must not kill a legitimately long-running
  concurrent program just because a single hamster loops many times.
- The last non-helper hamster finishes while helper hamsters are mid-action -> helpers are stopped
  cleanly and the terrain is left in a consistent state.
- A hamster is cancelled while pausing, while waiting for another hamster, or while suspended
  -> it wakes with a cancellation it can catch; a cancelled hamster that is merely running keeps
  running with a cancellation flag set.
- A hamster terminates abruptly while holding protected sections -> the sections are released.
- Two hamsters try to take the last grain on the same tile -> one succeeds, the other gets the
  normal "tile empty" error; the terrain never shows a negative or duplicated grain count.
- A hamster suspends or signals an object it does not currently protect -> clear, located error.
- The user presses Stop, Reset, or closes the simulator while hamsters are blocked -> everything
  is torn down without leaving stray activity behind.
- A program creates an unreasonable number of hamsters -> a documented limit is enforced with a
  clear message rather than freezing the editor.
- A program mixes concurrency with user input (reading a number from the terminal) -> only the
  asking hamster is blocked; the others keep running.
- The user steps a hamster that is currently blocked -> that hamster cannot advance; the user is
  told so, and the program advances whichever hamster the scheduler picks instead.
- The hamster the user had selected in the debugger finishes while the program is resumed ->
  selection moves to a live hamster rather than leaving a stale, empty stack.

## Requirements *(mandatory)*

### Functional Requirements

#### Starting and ending concurrent hamsters

- **FR-001**: The system MUST let a hamster object be started so that its own behaviour runs
  concurrently with the part of the program that started it.
- **FR-002**: The system MUST run every started hamster and the main part of the program over one
  shared terrain, so that actions of one hamster are immediately visible to all others.
- **FR-003**: The system MUST treat a started hamster with no overridden behaviour as a hamster
  that finishes immediately without error.
- **FR-004**: The system MUST reject starting a hamster that has already been started, with an
  error message carrying the source location.
- **FR-005**: The system MUST keep the program running until every started hamster that is not
  marked as a helper has finished, even after the main part of the program has returned.
- **FR-006**: The system MUST end the program and stop any still-running helper hamsters as soon
  as the last non-helper hamster has finished.
- **FR-007**: The system MUST let a hamster's behaviour be supplied either by overriding it on the
  hamster itself or by handing the hamster a separate behaviour object, matching the two forms
  used in the reference course material.
- **FR-008**: An uncaught error inside one hamster's behaviour MUST terminate only that hamster,
  report the error to the user, and leave the remaining hamsters running.

#### Scheduling and interleaving

- **FR-009**: The system MUST switch between runnable hamsters at least at every hamster action
  (moving, turning, picking up, putting down, each sense query) and at every point where a hamster
  blocks, so that interleaving is visible in the simulator.
- **FR-010**: The choice of which runnable hamster acts next MUST be varied rather than fixed, so
  that a program whose shared data is not protected can actually go wrong — the same unprotected
  program run repeatedly MUST be able to produce different outcomes, as it does in the reference
  simulator. Runs are consequently not guaranteed to be reproducible.
- **FR-011**: The system MUST let a hamster voluntarily offer a switch to the other hamsters.
- **FR-012**: Hamster priorities MUST influence how often a hamster is chosen: a higher-priority
  hamster is selected more often than a lower-priority one, without a lower-priority hamster ever
  being starved entirely. *Note: this is a knowing deviation from the reference, whose formula
  (`random() * (2 + MAX_PRIORITY - getPriority())`) gives higher-priority threads more no-op yield
  points — the opposite of the intuitive meaning adopted here. It must be written up under
  FR-038.*
- **FR-013**: Execution speed, stepping, and pausing in the simulator MUST apply to the program as
  a whole, so that lowering the speed slows all hamsters equally.
- **FR-014**: The existing runaway-loop safeguards MUST remain effective against genuinely stuck
  programs while not aborting a legitimate long-running concurrent program.

#### Mutual exclusion

- **FR-015**: The system MUST provide real mutual exclusion for sections of code marked as
  protected, both when protection is attached to a whole operation and when it guards a block of
  statements.
- **FR-016**: Protection MUST be per object, with protection on shared (class-level) operations
  applying across all instances of that class.
- **FR-017**: Protection MUST be re-entrant: a hamster already holding a given protected section
  can enter further sections guarded by the same object and only releases it after leaving the
  outermost one.
- **FR-018**: A protected section MUST be released when a hamster leaves it for any reason,
  including an error propagating out of it or the hamster being terminated.
- **FR-019**: Hamsters blocked at the entrance of a protected section MUST be shown as waiting and
  MUST be resumed when the section becomes free.

#### Waiting and signalling

- **FR-020**: The system MUST let a hamster inside a protected section suspend itself on that
  object, releasing the protection while suspended.
- **FR-021**: The system MUST let a hamster signal one, or all, hamsters suspended on an object.
- **FR-022**: A signalled hamster MUST re-acquire the protected section before it continues.
- **FR-023**: Suspending on, or signalling, an object whose protection the hamster does not hold
  MUST produce a clear, located error.
- **FR-024**: Suspending with a time limit MUST resume the hamster when the limit expires even if
  no signal arrives.

#### Lifetime control

- **FR-025**: The system MUST let a hamster wait until another named hamster has finished,
  optionally with a time limit.
- **FR-026**: The system MUST let a hamster pause for a stated duration, measured on the
  simulation's clock so that pausing, stepping, and speed changes affect it.
- **FR-027**: The system MUST let a hamster be cancelled; a cancelled hamster that is pausing,
  waiting for another hamster, or suspended MUST wake up and be able to react to the cancellation,
  while a cancelled hamster that is merely running MUST be able to query that it was cancelled.
- **FR-028**: The system MUST let a hamster be marked as a helper that does not keep the program
  alive, and MUST let a program ask whether a hamster is still running, and read and set its name.
- **FR-029**: The system MUST let a hamster be terminated abruptly, releasing everything it held.
- **FR-030**: The system MUST let the running code identify which hamster is currently acting.

#### Diagnostics and observation

- **FR-031**: The system MUST detect when no hamster can make progress any more and report it to
  the user, naming each hamster and what it is waiting for, instead of freezing silently.
- **FR-032**: The simulator MUST make clear which hamster performed the most recent action.
- **FR-033**: The debugger MUST present every live hamster as a separate thread the user can
  select, each with its own call stack, scopes, and variables, and MUST show a hamster that is
  blocked, suspended, pausing, or waiting for another hamster as being in that state.
- **FR-034**: When any hamster reaches a breakpoint or an error, the whole program MUST stop so
  the user can inspect every hamster; stepping MUST advance the hamster the user has selected and
  MUST report which hamster actually advanced when that hamster could not proceed.
- **FR-035**: Hamsters that start and finish while the debugger is attached MUST appear and
  disappear from the thread list as they do so.
- **FR-036**: Expression evaluation in the debugger MUST be resolved against the selected
  hamster's own frame, and MUST NOT perform hamster actions or change the scheduling state.
- **FR-037**: Stopping and resetting the simulation MUST terminate every hamster and leave no
  lingering activity.
- **FR-038**: A concurrency feature that the system recognises but deliberately implements
  differently from the reference simulator MUST be recorded in the port-status documentation, and
  the language skill's feature-gap list MUST be updated in the same change.

#### Compatibility

- **FR-039**: Programs that do not start any hamster MUST behave exactly as they do today, with no
  change in output, stepping behaviour, or performance.
- **FR-040**: Concurrency constructs MUST be recognised by syntax highlighting and MUST NOT produce
  false problems in the editor.
- **FR-041**: Concurrency-related errors MUST be reported in the same style as existing language
  errors, with a message and source location.

### Key Entities

- **Hamster thread**: one independently advancing strand of a program - either the main part of the
  program or a started hamster. Has an identity and name, a current position in its own code, a
  state (not yet started, runnable, running, blocked at a protected section, suspended, pausing,
  waiting for another hamster, finished), a helper flag, a priority, and a cancellation flag.
- **Protected section owner (monitor)**: any object or class that can guard code. Tracks which
  hamster currently holds it, how many times that hamster has entered it, which hamsters are
  queued at its entrance, and which hamsters are suspended on it.
- **Scheduler**: decides which runnable hamster acts next, at the switch points defined above, and
  recognises when no hamster can act any more.
- **Simulation clock**: the time base used for pausing and timed waiting; advances with the running
  simulation and stands still while the simulation is paused or being stepped.
- **Terrain**: the single shared state all hamster threads read and modify.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Of the **158** concurrency-using programs in the reference course material (Band 3
  chapters 10-12, out of ~950 reference sample programs), the **95 that need nothing beyond
  threads and monitors** run in the simulator and reach their intended outcome or their intended
  blocking state, with none failing because a concurrency feature is unsupported. The remaining 63
  are reported by category rather than counted as concurrency failures: 49 additionally need
  `util.AllroundHamster` (a pre-existing import gap, not concurrency — up to 144 become reachable
  once that is handled separately), 9 need `java.util.concurrent` or `java.util.Timer`, and 5 need
  collection classes. The last two groups are out of scope per the Assumptions below.
- **SC-002**: A teacher can demonstrate the difference between an unprotected and a protected
  version of the same shared-counter program: across 20 consecutive runs the protected version
  produces the correct total every time, while the unprotected version produces a wrong total at
  least once.
- **SC-002a**: Running the same concurrent program repeatedly produces visibly different
  interleavings, so students see that the order in which hamsters act is not fixed.
- **SC-003**: The classic coordination exercises - semaphore, bounded producer/consumer, dining
  philosophers, readers/writers - complete without losing or duplicating grain and without the
  simulator freezing.
- **SC-004**: Ten concurrently acting hamsters complete a fixed workload within 110% of the
  wall-clock time the same workload takes with one hamster at the same speed setting.
- **SC-005**: A program in which every hamster is permanently blocked tells the user it is stuck
  within 2 seconds, instead of appearing to hang.
- **SC-006**: A student watching the simulator can tell, at every step, which hamster just acted.
- **SC-007**: Every existing single-hamster program and every existing automated test behaves
  exactly as before: 100% of the current test suite passes unchanged.
- **SC-008**: A teacher can set a breakpoint inside one hamster's behaviour and inspect that
  hamster's variables within a single debugging session, without the other hamsters' state being
  confused with it.
- **SC-009**: While a concurrent program is stopped in the debugger, every live hamster is listed
  and selectable, and selecting a blocked hamster shows both its call stack and what it is
  waiting for.

## Assumptions

- **Scope is the Java-like object-oriented and class program types.** Imperative Band-1 programs
  have no way to create a second hamster and are unaffected; the non-Java frontends remain out of
  scope.
- **Cooperative, single-at-a-time execution.** Hamsters appear to act concurrently but only one
  acts at any instant, switching at defined points. No true parallelism is introduced, and the
  extension host is never blocked.
- **Scheduling is varied, so concurrent runs are not reproducible** (decision on FR-010). This is
  deliberate: the Band 3 chapter 11/12 exercises exist to show that unprotected shared data goes
  wrong, which a fixed order would hide. Two consequences are accepted:
  - Automated coverage for concurrent programs asserts *invariants* that must hold under every
    interleaving (no grain lost or duplicated, a protected total is always correct, the program
    terminates) rather than one exact sequence of actions, so the test suite stays reliable.
  - A student who sees a concurrent program fail cannot necessarily reproduce that exact failure
    by re-running it. Reporting a failed run therefore includes enough state for the user to
    understand it without a replay.
- **The debugger models each hamster as its own thread** (decision on FR-033), as a Java IDE
  does. Because execution is cooperative, only one hamster is ever mid-action, so a breakpoint
  stops the whole program and every hamster can be inspected at a consistent point.
- **The thread surface mirrors the reference simulator's hamster API** as used by the course
  material: starting a hamster, defining its behaviour, pausing, waiting for another hamster to
  finish, cancelling, querying cancellation, abrupt termination, helper (daemon) marking, liveness
  query, name, priority, identifying the current hamster, voluntarily offering a switch, protected
  sections on operations and blocks, suspending, signalling one or all, and the cancellation error
  type. General-purpose library classes (collection types, executor services, concurrency
  utilities) remain out of scope and keep failing with the existing "unsupported class" message.
- **Pausing and timed waiting use the simulation clock**, not wall-clock time, so that stepping in
  the debugger and changing the speed slider behave sensibly. The mapping from a stated duration to
  simulation time is documented as a deliberate deviation.
- **Hamster actions are indivisible.** A single move, turn, pick-up, put-down, or sense query
  completes before another hamster acts, so the terrain is never observed half-updated. This
  matches the reference simulator, where each such operation is itself protected.
- **An uncaught error in one hamster does not end the program**, matching the reference
  simulator's behaviour of reporting it and letting the other hamsters continue.
- **A documented upper limit on the number of simultaneously running hamsters** is enforced to keep
  the editor responsive; the limit is generous enough for all course material.
- **Deviations are documented, not hidden.** Any place where cooperative scheduling cannot
  reproduce the reference simulator's pre-emptive behaviour is recorded in the port-status
  documentation, as the project's reference-fidelity rule requires.

## Dependencies

- Builds on the existing support for multiple hamster objects in one terrain and the existing
  step-wise execution protocol that drives the simulator and the debugger.
- Touches the simulator webview (what the user sees acting), the debugger (stacks and stepping),
  and the editor diagnostics (no false problems on concurrency syntax).
- Verification of outcome fidelity depends on the reference sample corpus, which lives outside
  this repository.
