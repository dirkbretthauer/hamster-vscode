/**
 * Cooperative scheduler: thread lifecycle, monitors, and selection.
 *
 * Loads `lang/*.js` as base64 data-URL modules so the ES sources can be
 * exercised directly from a CommonJS-flavoured package, matching the pattern in
 * `test/simulatorRuntime.test.mjs`.
 *
 * Scheduling is deliberately varied (FR-010), so every assertion here is about
 * an invariant that must hold under *any* interleaving — never one exact
 * sequence of actions. The injected `random` keeps the suite reliable; it is a
 * test seam, not a user-facing seed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function moduleUrl(source) {
    return 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
}

function readLangModule(name, replacements = []) {
    let source = fs.readFileSync(path.join(root, 'lang', name), 'utf8');
    for (const [specifier, url] of replacements) {
        source = source.replace(JSON.stringify(specifier).replace(/"/g, "'"), JSON.stringify(url));
    }
    return moduleUrl(source);
}

let modulesPromise = null;
function loadModules() {
    if (!modulesPromise) {
        modulesPromise = (async () => {
            const lexerUrl = readLangModule('hamster-lexer.js');
            const parserUrl = readLangModule('hamster-parser.js', [['./hamster-lexer.js', lexerUrl]]);
            const runnerUrl = readLangModule('hamster-runner.js', [['./hamster-parser.js', parserUrl]]);
            const schedulerUrl = readLangModule('hamster-scheduler.js', [['./hamster-runner.js', runnerUrl]]);
            return {
                parser: await import(parserUrl),
                runner: await import(runnerUrl),
                scheduler: await import(schedulerUrl),
            };
        })();
    }
    return modulesPromise;
}

/** mulberry32: stays in 32-bit integer maths, so it cannot collapse toward zero. */
function seededRandom(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6D2B79F5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function createTestRuntime(log) {
    return {
        resolveIdentifier(name) {
            return /^[A-Z][A-Za-z0-9_]*$/.test(name) ? { __kind: 'class', name } : undefined;
        },
        createObject(className) {
            return className.endsWith('Hamster')
                ? { __kind: 'hamster', id: 0, className }
                : { __kind: 'object', className, fields: Object.create(null) };
        },
        getMember(receiver, property) {
            return receiver && receiver.__kind === 'object' ? receiver.fields[property] : undefined;
        },
        setMember(receiver, property, value) {
            if (receiver && receiver.__kind === 'object') { receiver.fields[property] = value; return true; }
            return false;
        },
        callMethod(receiver, methodName, args) { return this.callBuiltin(methodName, args); },
        callBuiltin(name, args) {
            const method = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name;
            if (method === 'schreib' || method === 'write') { log.push(String(args[0])); return undefined; }
            if (['vor', 'linksUm', 'nimm', 'gib'].includes(method)) return undefined;
            if (method === 'vornFrei' || method === 'kornDa') return true;
            if (method === 'maulLeer') return false;
            throw new Error('Unknown function: ' + name);
        },
    };
}

/** Run a program to completion (or deadlock) and report what happened. */
async function runProgram(source, { seed = 1, maxSteps = 20000 } = {}) {
    const { parser, runner, scheduler: schedulerModule } = await loadModules();
    const log = [];
    const ast = parser.parseProgram(source, { compatibility: true, strict: true });
    const state = runner.createRunnerState(ast, createTestRuntime(log), [], {
        createScheduler: (programState) =>
            schedulerModule.createScheduler(programState, { random: seededRandom(seed) }),
    });
    const scheduler = state.programState.scheduler;
    const errors = [];
    let steps = 0;
    let result;
    while (true) {
        result = scheduler.step();
        for (const event of result.events) {
            if (event.kind === 'error') errors.push(event.error.message);
        }
        if (result.status === 'finished' || result.status === 'deadlocked') break;
        assert.ok(++steps < maxSteps, 'program did not terminate (status ' + result.status + ')');
    }
    const staticOf = (className, field) => state.staticFields.get(className).get(field);
    return { state, scheduler, result, log, errors, staticOf };
}

// ── state split invariants ──────────────────────────────────────────────────

test('every thread shares the one globals scope and the one static field table', async () => {
    const { state, scheduler } = await runProgram(`
        int shared;
        class W extends Hamster {
            W() { super(0, 0, 1, 0); }
            public void run() { shared = shared + 1; }
        }
        void main() { W a = new W(); a.start(); }
    `);
    const all = scheduler.threads();
    assert.equal(all.length, 2, 'main plus one started hamster');
    for (const thread of all) {
        assert.equal(thread.state.scopes[0], state.programState.globalScope,
            'scopes[0] must be the same Map object, or globals fork silently');
        assert.equal(thread.state.staticFields, state.programState.staticFields);
    }
});

// ── selection ───────────────────────────────────────────────────────────────

test('weighted selection favours higher priority without starving anyone', async () => {
    const { runner, scheduler: schedulerModule, parser } = await loadModules();
    const log = [];
    const ast = parser.parseProgram('void main() { }', { compatibility: true, strict: true });
    const state = runner.createRunnerState(ast, createTestRuntime(log), [], {
        createScheduler: (programState) =>
            schedulerModule.createScheduler(programState, { random: seededRandom(7) }),
    });
    const scheduler = state.programState.scheduler;

    const low = scheduler.spawn({ __className: 'Low' }, null, 'Low');
    const high = scheduler.spawn({ __className: 'High' }, null, 'High');
    scheduler.start(low);
    scheduler.start(high);
    low.priority = schedulerModule.MIN_PRIORITY;
    high.priority = schedulerModule.MAX_PRIORITY;
    scheduler.threadById(1).status = schedulerModule.ThreadStatus.TERMINATED;

    const picks = { Low: 0, High: 0 };
    for (let i = 0; i < 4000; i++) {
        // Keep both runnable so selection, not progress, is what is measured.
        low.status = schedulerModule.ThreadStatus.RUNNABLE;
        high.status = schedulerModule.ThreadStatus.RUNNABLE;
        picks[scheduler.step().thread.name] += 1;
    }
    assert.ok(picks.High > picks.Low * 3, 'priority 10 must be picked far more than priority 1');
    assert.ok(picks.Low > 0, 'priority 1 must never be starved entirely');
});

// ── User Story 1: threads ───────────────────────────────────────────────────

test('two started hamsters interleave and observe each other through a static field', async () => {
    const { log, staticOf } = await runProgram(`
        class W extends Hamster {
            static int counter = 0;
            String tag;
            W(String t) { super(0, 0, 1, 0); this.tag = t; }
            public void run() {
                int i = 0;
                while (i < 4) { schreib(this.tag); W.counter = W.counter + 1; i = i + 1; }
            }
        }
        void main() { W a = new W("A"); W b = new W("B"); a.start(); b.start(); }
    `);
    assert.equal(staticOf('W', 'counter'), 8, 'both threads increment the shared static');
    assert.equal(log.filter(entry => entry === 'A').length, 4);
    assert.equal(log.filter(entry => entry === 'B').length, 4);
});

test('starting an already started hamster reports an error and kills only that thread', async () => {
    const { errors, result } = await runProgram(`
        class W extends Hamster { W() { super(0,0,1,0); } public void run() { schreib("x"); } }
        void main() { W a = new W(); a.start(); a.start(); }
    `);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /already been started/);
    assert.equal(result.status, 'finished', 'the program still completes');
});

test('a started hamster with no run() override finishes immediately without error', async () => {
    const { log, errors, result } = await runProgram(`
        class W extends Hamster { W() { super(0,0,1,0); } }
        void main() { W a = new W(); a.start(); schreib("done"); }
    `);
    assert.deepEqual(log, ['done']);
    assert.deepEqual(errors, []);
    assert.equal(result.status, 'finished');
});

test('the program keeps running after main returns until every non-daemon thread is done', async () => {
    const { log } = await runProgram(`
        class W extends Hamster {
            W() { super(0,0,1,0); }
            public void run() { int i = 0; while (i < 4) { schreib("w"); i = i + 1; } }
        }
        void main() { W a = new W(); a.start(); schreib("mainDone"); }
    `);
    assert.equal(log.filter(entry => entry === 'w').length, 4);
    assert.ok(log.indexOf('mainDone') < log.lastIndexOf('w'), 'the thread outlives main');
});

test('an uncaught error in one hamster leaves the others running', async () => {
    const { log, errors } = await runProgram(`
        class Boom extends Hamster {
            Boom() { super(0,0,1,0); }
            public void run() { throw new RuntimeException("boom"); }
        }
        class Fine extends Hamster {
            Fine() { super(0,0,1,0); }
            public void run() { int i = 0; while (i < 3) { schreib("fine"); i = i + 1; } }
        }
        void main() { Boom b = new Boom(); Fine f = new Fine(); b.start(); f.start(); }
    `);
    assert.equal(errors.length, 1, 'exactly one thread died');
    assert.equal(log.filter(entry => entry === 'fine').length, 3, 'the other thread completed');
});

// ── User Story 2: mutual exclusion ──────────────────────────────────────────

test('a synchronized block admits at most one thread at a time', async () => {
    const { staticOf } = await runProgram(`
        class W extends Hamster {
            static int inside = 0;
            static int maxInside = 0;
            W() { super(0,0,1,0); }
            public void run() {
                int i = 0;
                while (i < 6) {
                    synchronized (W.class) {
                        W.inside = W.inside + 1;
                        if (W.inside > W.maxInside) { W.maxInside = W.inside; }
                        schreib("in");
                        W.inside = W.inside - 1;
                    }
                    i = i + 1;
                }
            }
        }
        void main() { W a = new W(); W b = new W(); W c = new W(); a.start(); b.start(); c.start(); }
    `);
    assert.equal(staticOf('W', 'maxInside'), 1, 'mutual exclusion violated');
    assert.equal(staticOf('W', 'inside'), 0, 'every entry was matched by an exit');
});

test('a protected counter is always exact where an unprotected one can be wrong', async () => {
    const protectedProgram = `
        class W extends Hamster {
            static int total = 0;
            W() { super(0,0,1,0); }
            static synchronized void bump() { int seen = W.total; schreib("t"); W.total = seen + 1; }
            public void run() { int i = 0; while (i < 5) { W.bump(); i = i + 1; } }
        }
        void main() { W a = new W(); W b = new W(); a.start(); b.start(); }
    `;
    for (let seed = 1; seed <= 20; seed++) {
        const { staticOf } = await runProgram(protectedProgram, { seed });
        assert.equal(staticOf('W', 'total'), 10, 'protected total must be exact on seed ' + seed);
    }
});

test('synchronized methods are re-entrant and do not self-deadlock', async () => {
    const { log, result } = await runProgram(`
        class W extends Hamster {
            W() { super(0,0,1,0); }
            synchronized void outer() { this.inner(); }
            synchronized void inner() { schreib("i"); }
            public void run() { int i = 0; while (i < 4) { this.outer(); i = i + 1; } }
        }
        void main() { W a = new W(); W b = new W(); a.start(); b.start(); }
    `);
    assert.equal(result.status, 'finished');
    assert.equal(log.length, 8);
});

test('a monitor is released when an exception unwinds out of a synchronized block', async () => {
    const { log, result } = await runProgram(`
        class Lock { int unused = 0; }
        class W extends Hamster {
            Lock lock; boolean boom;
            W(Lock l, boolean b) { super(0,0,1,0); this.lock = l; this.boom = b; }
            public void run() {
                try {
                    synchronized (this.lock) {
                        if (this.boom) { throw new RuntimeException("x"); }
                        schreib("ok");
                    }
                } catch (RuntimeException e) { schreib("caught"); }
            }
        }
        void main() {
            Lock lock = new Lock();
            W a = new W(lock, true);
            W b = new W(lock, false);
            a.start();
            b.start();
        }
    `);
    assert.equal(result.status, 'finished', 'the second thread must not be stranded');
    assert.ok(log.includes('caught') && log.includes('ok'));
});

// ── User Story 3: wait / notify ─────────────────────────────────────────────

test('wait releases the monitor and notifyAll wakes every waiter', async () => {
    const { log, result } = await runProgram(`
        class Box {
            boolean ready = false;
            synchronized void await() {
                while (!this.ready) { try { this.wait(); } catch (InterruptedException e) {} }
                schreib("got");
            }
            synchronized void signal() { this.ready = true; this.notifyAll(); }
        }
        class W extends Hamster {
            Box box; boolean producer;
            W(Box b, boolean p) { super(0,0,1,0); this.box = b; this.producer = p; }
            public void run() { if (this.producer) { this.box.signal(); } else { this.box.await(); } }
        }
        void main() {
            Box box = new Box();
            W c1 = new W(box, false);
            W c2 = new W(box, false);
            W p = new W(box, true);
            c1.start(); c2.start(); p.start();
        }
    `);
    assert.equal(result.status, 'finished');
    assert.equal(log.filter(entry => entry === 'got').length, 2, 'both waiters woke');
});

test('wait without owning the monitor is a located error', async () => {
    const { errors } = await runProgram(`
        class Box { int unused = 0; }
        void main() { Box box = new Box(); box.wait(); }
    `);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /requires the monitor/);
});

test('notify without owning the monitor is a located error', async () => {
    const { errors } = await runProgram(`
        class Box { int unused = 0; }
        void main() { Box box = new Box(); box.notifyAll(); }
    `);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /requires the monitor/);
});

test('a program where every hamster is blocked reports a deadlock instead of hanging', async () => {
    const { result } = await runProgram(`
        class Box { synchronized void stuck() { try { this.wait(); } catch (InterruptedException e) {} } }
        class W extends Hamster {
            Box box;
            W(Box b) { super(0,0,1,0); this.box = b; }
            public void run() { this.box.stuck(); }
        }
        void main() { Box box = new Box(); W a = new W(box); a.start(); }
    `);
    assert.equal(result.status, 'deadlocked');
    assert.match(result.report, /All hamsters are blocked/);
});

test('a timed wait expires even when nobody signals', async () => {
    const { log, result } = await runProgram(`
        class Box { synchronized void waitABit() { try { this.wait(50); } catch (InterruptedException e) {} schreib("woke"); } }
        void main() { Box box = new Box(); box.waitABit(); }
    `);
    assert.equal(result.status, 'finished');
    assert.deepEqual(log, ['woke']);
});

// ── User Story 4: lifetime ──────────────────────────────────────────────────

test('join resumes once the joined hamster has terminated', async () => {
    const { log } = await runProgram(`
        class W extends Hamster {
            W() { super(0,0,1,0); }
            public void run() { int i = 0; while (i < 3) { schreib("w"); i = i + 1; } schreib("worker done"); }
        }
        void main() {
            W a = new W();
            a.start();
            try { a.join(); } catch (InterruptedException e) {}
            schreib("joined");
        }
    `);
    assert.equal(log[log.length - 1], 'joined');
    assert.ok(log.indexOf('worker done') < log.indexOf('joined'));
});

test('interrupt breaks a sleeping hamster with a catchable InterruptedException', async () => {
    const { log } = await runProgram(`
        class W extends Hamster {
            W() { super(0,0,1,0); }
            public void run() {
                try { Thread.sleep(100000); schreib("not reached"); }
                catch (InterruptedException e) { schreib("interrupted"); }
            }
        }
        void main() { W a = new W(); a.start(); a.interrupt(); }
    `);
    assert.deepEqual(log, ['interrupted']);
});

test('Thread.interrupted clears the flag while isInterrupted does not', async () => {
    const { log } = await runProgram(`
        class W extends Hamster {
            W() { super(0,0,1,0); }
            public void run() {
                int i = 0;
                while (i < 40) { i = i + 1; }
                schreib("flag=" + this.isInterrupted());
                schreib("again=" + this.isInterrupted());
                schreib("consumed=" + Thread.interrupted());
                schreib("after=" + Thread.interrupted());
            }
        }
        void main() { W a = new W(); a.start(); a.interrupt(); }
    `);
    assert.deepEqual(log, ['flag=true', 'again=true', 'consumed=true', 'after=false']);
});

test('a daemon hamster does not keep the program alive', async () => {
    const { log, result } = await runProgram(`
        class W extends Hamster {
            W() { super(0,0,1,0); }
            public void run() { while (true) { schreib("tick"); } }
        }
        void main() { W a = new W(); a.setDaemon(true); a.start(); schreib("mainDone"); }
    `);
    assert.equal(result.status, 'finished');
    assert.ok(log.includes('mainDone'));
});

test('setDaemon after start is rejected', async () => {
    const { errors } = await runProgram(`
        class W extends Hamster { W() { super(0,0,1,0); } public void run() { schreib("x"); } }
        void main() { W a = new W(); a.start(); a.setDaemon(true); }
    `);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /setDaemon must be called before start/);
});

test('a priority outside 1..10 is rejected', async () => {
    const { errors } = await runProgram(`
        class W extends Hamster { W() { super(0,0,1,0); } public void run() { schreib("x"); } }
        void main() { W a = new W(); a.setPriority(42); a.start(); }
    `);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /priority must be between 1 and 10/);
});

test('stop releases every monitor the terminated hamster held', async () => {
    const { result, log } = await runProgram(`
        class Lock { int unused = 0; }
        class Holder extends Hamster {
            Lock lock;
            Holder(Lock l) { super(0,0,1,0); this.lock = l; }
            public void run() { synchronized (this.lock) { while (true) { schreib("hold"); } } }
        }
        class Taker extends Hamster {
            Lock lock; Holder other;
            Taker(Lock l, Holder h) { super(0,0,1,0); this.lock = l; this.other = h; }
            public void run() { this.other.stop(); synchronized (this.lock) { schreib("took"); } }
        }
        void main() {
            Lock lock = new Lock();
            Holder h = new Holder(lock);
            Taker t = new Taker(lock, h);
            h.start();
            t.start();
        }
    `);
    assert.equal(result.status, 'finished', 'the taker must not be stranded on a dead holder lock');
    assert.ok(log.includes('took'));
});

test('isAlive reflects the thread lifecycle', async () => {
    const { log } = await runProgram(`
        class W extends Hamster {
            W() { super(0,0,1,0); }
            public void run() { schreib("running"); }
        }
        void main() {
            W a = new W();
            schreib("before=" + a.isAlive());
            a.start();
            try { a.join(); } catch (InterruptedException e) {}
            schreib("after=" + a.isAlive());
        }
    `);
    assert.ok(log.includes('before=false'));
    assert.ok(log.includes('after=false'));
});

// ── runaway-loop guard (FR-014) ─────────────────────────────────────────────

test('a hamster looping forever while acting is not killed by the loop guard', async () => {
    const { result, staticOf } = await runProgram(`
        class W extends Hamster {
            static int n = 0;
            W() { super(0,0,1,0); }
            public void run() { while (true) { this.vor(); W.n = W.n + 1; } }
        }
        void main() { W a = new W(); a.setDaemon(true); a.start(); int i = 0; while (i < 60) { vor(); i = i + 1; } }
    `, { maxSteps: 5000 });
    assert.equal(result.status, 'finished');
    assert.ok(staticOf('W', 'n') > 0, 'the daemon made real progress before the program ended');
});

test('a loop that makes no progress at all still trips the guard', async () => {
    const { errors } = await runProgram(`
        void main() { int i = 0; while (true) { i = i + 1; } }
    `, { maxSteps: 200 });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Loop iteration limit exceeded/);
});
