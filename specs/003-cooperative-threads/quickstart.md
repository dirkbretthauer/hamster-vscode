# Quickstart: validating Cooperative Hamster Threads

**Feature**: `specs/003-cooperative-threads` | **Date**: 2026-10-06

How to prove the feature works end to end. Scenarios map to the spec's user stories and success
criteria. Details of the API live in [contracts/ham-thread-api.md](contracts/ham-thread-api.md);
ids and state transitions in [data-model.md](data-model.md).

## Prerequisites

```bash
npm install
npm run compile
```

The reference corpus is optional and lives outside the repo. Scenario 6 needs it:

```bash
# default location, or set HAMSTER_REFERENCE_DIR
D:\Projects\hamstersimulator-v29-06-eclipse\...\hamstersimulator-2.9.6
```

## Automated gates

```bash
npm test             # scripts/language-smoke.cjs + node --test
npm run compile      # webpack
npm run conformance  # parse-only; expect NO change (research R12)
```

`npm run conformance` is a regression check here, not a target: this feature adds no syntax, so the
parse rate must stay exactly where it is. In PowerShell, pass flags as
`npm run conformance -- --min-pass-rate=1`.

---

## Scenario 1 — Two hamsters act at the same time (US1, SC-006)

`FrissHamster.ham` (a `/*class*/` file) and `kommunizieren.ham` beside it:

```java
/*class*/class FrissHamster extends Hamster {
    FrissHamster(int r, int s) { super(r, s, Hamster.OST, 0); }
    public void run() {
        while (this.vornFrei()) { this.vor(); if (this.kornDa()) this.nimm(); }
    }
}
```

```java
/*object-oriented program*/void main() {
    FrissHamster paul = new FrissHamster(1, 0);
    FrissHamster willi = new FrissHamster(2, 0);
    paul.start();
    willi.start();
}
```

**Expected**: both hamsters move, visibly alternating; the simulator marks whichever acted last;
the program reports Finished only after both stop. Run it twice — the interleaving differs
(SC-002a).

## Scenario 2 — Unprotected vs protected counter (US2, SC-002)

Same program twice, once with `synchronized (FrissHamster.class) { … }` around the
read-modify-write of a `static int` and once without.

**Expected**: protected ⇒ the correct total on all 20 runs. Unprotected ⇒ a wrong total at least
once in 20. If the unprotected version is *always* right, the switch points are too coarse —
that is the FR-010 failure mode to watch for.

## Scenario 3 — Semaphore, producer/consumer, philosophers (US3, SC-003)

Run `kapitel 12/abschnitt 12.1/einseitige-synchronisation/` (student-built `Semaphor` using only
`wait`/`notify`), `kapitel 11/abschnitt 11.2/` (bounded buffer), and
`kapitel 11/abschnitt 11.3/loesung 2/` (philosophers).

**Expected**: no grain lost or duplicated, no buffer overrun, no freeze. A philosopher solution
that is *supposed* to deadlock must report the deadlock (FR-031), not hang.

## Scenario 4 — Helper lifetime (US4)

`kapitel 10/abschnitt 10.5/daemonen.ham` — two daemon helpers, `join()`, and `interrupt()` used to
break the join.

**Expected**: the boss resumes as soon as the first helper reports; the other helper does not keep
the program alive; the `catch (InterruptedException exc)` branch is taken.

## Scenario 5 — Debugging two hamsters (US5, SC-008, SC-009)

1. F5 → Extension Development Host, open Scenario 1's program.
2. Breakpoint inside `run()`. Start debugging.
3. **Expected**: the Call Stack view lists `main` plus one entry per started hamster, by name.
4. Select each thread — its own frames, locals, and `this` appear; no cross-talk.
5. Select a *blocked* hamster — its stack shows, and it reads as waiting.
6. Step with one thread selected — that thread advances; the simulator shows which hamster acted.
7. Resume. Threads appear and disappear from the list as hamsters start and finish.

## Scenario 6 — Corpus sweep (SC-001)

```bash
node scripts/concurrency-corpus.cjs   # added by this feature
```

**Expected**: the 95 programs needing nothing beyond threads and monitors reach their intended
outcome or intended blocking state. The 14 blocked by `java.util.concurrent` / collections are
reported as out of scope, and the 49 needing `util.AllroundHamster` as a pre-existing import gap —
**not** as concurrency failures. See [research.md](research.md) R11 for the derivation and the
SC-001 correction.

## Scenario 7 — Regression: single-threaded programs (SC-007)

Open any Band 1 program that starts no hamster.

**Expected**: identical behaviour, output, stepping, and speed to before. `npm test` passes
unchanged except for the three thread-unsupported assertions at
`test/simulatorRuntime.test.mjs:56-69`, which are **replaced** (not deleted) with assertions
pinning the new behaviour.

## Scenario 8 — Web Extension Host (constitution principle IV)

`Developer: Open Web Extension Host`, repeat Scenario 1.

**Expected**: identical. The scheduler must introduce no Node-only API, no `setInterval` leak, and
no blocking of the extension host.

---

## Manual checklist for the PR test plan

- [ ] Scenarios 1–5 and 7 pass in the Extension Development Host (F5)
- [ ] Scenario 8 passes in the Web Extension Host
- [ ] `npm test` and `npm run compile` pass
- [ ] `npm run conformance` shows no change in parse rate
- [ ] Stop and Reset mid-run leave no hamster moving and no stray timer
- [ ] A `while (true)` hamster runs until Stop without hitting a loop-limit error (FR-014)
- [ ] `spec/vscode-port-status.md` and the `hamster-language` skill gap list updated (FR-038)
