/**
 * End-to-end simulation tests: a real `.ham` program, on a real `.ter` terrain,
 * through the real parser, runner, scheduler, simulator engine and runtime
 * adapter — then assertions on what actually happened in the terrain.
 *
 * This is the layer `scripts/language-smoke.cjs` cannot reach: that suite uses
 * a hand-rolled fake runtime, so it proves the interpreter walks the AST but
 * nothing about hamsters moving, grain being picked up, or walls blocking.
 * Here `vor()` really moves a hamster and really throws at a wall.
 *
 * The harness itself lives in `scripts/test-helpers/simulationHarness.mjs` so
 * it can also be driven from a script over a whole folder of programs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    runSimulation, terrainFile, DIR_NORTH, DIR_EAST, DIR_SOUTH, DIR_WEST,
} from '../scripts/test-helpers/simulationHarness.mjs';

// ── basic movement and sensing ──────────────────────────────────────────────

test('a hamster walks forward and the terrain records the move', async () => {
    const run = await runSimulation({
        terrain: terrainFile(['>    ', '     ', '     '], [0], 0),
        program: 'void main() { vor(); vor(); }',
    });
    assert.equal(run.status, 'finished');
    const paul = run.hamster();
    assert.equal(paul.x, 2, 'moved two cells east');
    assert.equal(paul.y, 0);
    assert.equal(paul.dir, DIR_EAST);
});

test('linksUm turns the hamster anticlockwise through all four directions', async () => {
    const run = await runSimulation({
        terrain: terrainFile(['>    ', '     '], [0], 0),
        program: 'void main() { linksUm(); linksUm(); linksUm(); }',
    });
    assert.equal(run.hamster().dir, DIR_SOUTH, 'east -> north -> west -> south');
});

test('a hamster picks up grain and the pile shrinks', async () => {
    const run = await runSimulation({
        // Hamster on (0,0), a pile of 3 grains at (0,2). The corn list covers the
        // `*` and hamster cells in row-major order, so it is [cell(0,0), cell(0,2)].
        terrain: terrainFile(['> *', '   '], [0, 3], 0),
        program: 'void main() { vor(); vor(); nimm(); nimm(); }',
    });
    assert.equal(run.status, 'finished');
    assert.equal(run.hamster().mouth, 2, 'two grains in the mouth');
    assert.equal(run.cornAt(0, 2), 1, 'one grain left on the tile');
    assert.equal(run.totalCorn() + run.hamster().mouth, 3, 'no grain created or destroyed');
});

test('gib puts grain back on the tile', async () => {
    const run = await runSimulation({
        terrain: terrainFile(['>  ', '   '], [0], 5),
        program: 'void main() { gib(); gib(); }',
    });
    assert.equal(run.hamster().mouth, 3);
    assert.equal(run.cornAt(0, 0), 2);
});

// ── walls, exceptions, and sensing ──────────────────────────────────────────

test('walking into a wall throws a catchable WallInFrontException and the hamster stays put', async () => {
    const run = await runSimulation({
        terrain: terrainFile(['>#  ', '    '], [0], 0),
        program: `
            void main() {
                try { vor(); schreib("moved"); }
                catch (MauerDaException e) { schreib("blocked"); }
            }
        `,
    });
    assert.equal(run.status, 'finished');
    assert.deepEqual(run.output, ['blocked']);
    assert.equal(run.hamster().x, 0, 'the hamster did not move through the wall');
});

test('vornFrei reports the wall ahead', async () => {
    const run = await runSimulation({
        terrain: terrainFile(['>#  ', '    '], [0], 0),
        program: 'void main() { schreib("free=" + vornFrei()); }',
    });
    assert.deepEqual(run.output, ['free=false']);
});

test('taking grain from an empty tile throws KachelLeerException', async () => {
    const run = await runSimulation({
        terrain: terrainFile(['>  ', '   '], [0], 0),
        program: `
            void main() {
                try { nimm(); schreib("took"); }
                catch (KachelLeerException e) { schreib("empty"); }
            }
        `,
    });
    assert.deepEqual(run.output, ['empty']);
});

// ── a complete task: collect every grain in a row ───────────────────────────

test('a collector program clears every grain in its row', async () => {
    const run = await runSimulation({
        terrain: terrainFile(['>**  ', '     '], [0, 2, 1], 0),
        program: `
            void main() {
                while (vornFrei()) {
                    vor();
                    while (kornDa()) { nimm(); }
                }
            }
        `,
    });
    assert.equal(run.status, 'finished');
    assert.equal(run.totalCorn(), 0, 'the row is cleared');
    assert.equal(run.hamster().mouth, 3, 'all three grains collected');
    assert.equal(run.hamster().x, 4, 'walked to the far wall');
});

// ── running real .ham / .ter files from disk ────────────────────────────────

test('a .ham file runs against the .ter file that shares its basename', async () => {
    // Nothing but the program path: the terrain is paired automatically, the
    // same way the extension pairs it when you press Run.
    const run = await runSimulation({
        programPath: 'test/fixtures/simulation/collectRow.ham',
    });
    assert.equal(run.status, 'finished');
    assert.equal(run.totalCorn(), 0, 'the row is cleared');
    assert.equal(run.hamster().mouth, 5, 'collected both piles (2 + 3)');
    assert.equal(run.hamster().x, 4, 'walked to the far wall');
});

test('a .ter file can be pointed at explicitly, overriding the basename pairing', async () => {
    const run = await runSimulation({
        programPath: 'test/fixtures/simulation/collectRow.ham',
        terrainPath: 'test/fixtures/simulation/twoCollectors.ter',
    });
    assert.equal(run.status, 'finished');
    // The default hamster of twoCollectors.ter starts on the bottom row, which
    // has no grain, so it walks the row and collects nothing.
    assert.equal(run.hamster().mouth, 0);
    assert.equal(run.totalCorn(), 10, 'the other rows are untouched');
});

test('class programs in the folder are discovered and threads run from a file pair', async () => {
    const run = await runSimulation({
        programPath: 'test/fixtures/simulation/twoCollectors.ham',
    });
    assert.equal(run.status, 'finished');
    assert.equal(run.totalCorn(), 0, 'both rows cleared');
    const collected = run.hamsters().reduce((sum, h) => sum + h.mouth, 0);
    assert.equal(collected, 10, 'all grain accounted for across both hamsters');
});

test('inline sources still work and win over the file paths', async () => {
    const run = await runSimulation({
        programPath: 'test/fixtures/simulation/collectRow.ham',
        program: 'void main() { linksUm(); }',
    });
    assert.equal(run.hamster().dir, DIR_NORTH, 'the inline program ran, not the file');
    assert.equal(run.totalCorn(), 5, 'but the paired terrain still loaded');
});

// ── terrain file fidelity ───────────────────────────────────────────────────

test('a .ter file loads walls, grain, and the hamster placement', async () => {
    const run = await runSimulation({
        terrain: terrainFile(['  #  ', ' v*  ', '     '], [0, 4], 7),
        program: 'void main() { }',
    });
    const paul = run.hamster();
    assert.equal(paul.x, 1);
    assert.equal(paul.y, 1);
    assert.equal(paul.dir, DIR_SOUTH);
    assert.equal(paul.mouth, 7, 'the mouth line is honoured');
    assert.equal(run.terrainState.walls[0][2], 1, 'the wall is where the file put it');
    assert.equal(run.cornAt(1, 2), 4);
    assert.equal(run.terrainState.width, 5);
    assert.equal(run.terrainState.height, 3);
});

test('the terrain after a run is still a loadable .ter file', async () => {
    const run = await runSimulation({
        terrain: terrainFile(['>* ', '   '], [0, 2], 0),
        program: 'void main() { vor(); nimm(); }',
    });
    const rewritten = run.serialize();
    const reloaded = await runSimulation({ terrain: rewritten, program: 'void main() { }' });
    assert.equal(reloaded.hamster().x, 1, 'the hamster kept its position across a round trip');
    assert.equal(reloaded.cornAt(0, 1), 1);
});

// ── terminal input ──────────────────────────────────────────────────────────

test('liesZahl consumes a supplied answer and the program uses it', async () => {
    const run = await runSimulation({
        terrain: terrainFile(['>    ', '     '], [0], 0),
        program: `
            void main() {
                int steps = liesZahl("How far?");
                int i = 0;
                while (i < steps) { vor(); i = i + 1; }
            }
        `,
        inputs: [3],
    });
    assert.equal(run.status, 'finished');
    assert.equal(run.hamster().x, 3);
});

test('a program waiting for input that never arrives reports the prompt', async () => {
    const run = await runSimulation({
        terrain: terrainFile(['>  ', '   '], [0], 0),
        program: 'void main() { int n = liesZahl("How far?"); }',
        inputs: [],
    });
    assert.equal(run.unansweredPrompt, 'How far?');
});

// ── concurrency over a real terrain ─────────────────────────────────────────

test('two hamster threads collect from one terrain without losing grain', async () => {
    const run = await runSimulation({
        // Two hamsters, one per row, each with grain ahead of it.
        terrain: terrainFile(['>**  ', '>**  ', '     '], [0, 3, 2, 0, 1, 4], 0),
        classModules: [`
            /*class*/class Collector extends Hamster {
                Collector(int row) { super(row, 0, Hamster.OST, 0); }
                public void run() {
                    while (this.vornFrei()) {
                        this.vor();
                        while (this.kornDa()) { this.nimm(); }
                    }
                }
            }
        `],
        program: `
            /*object-oriented program*/void main() {
                Collector a = new Collector(0);
                Collector b = new Collector(1);
                a.start();
                b.start();
            }
        `,
    });
    assert.equal(run.status, 'finished');
    assert.equal(run.totalCorn(), 0, 'every pile was cleared');
    const collected = run.hamsters().reduce((sum, h) => sum + h.mouth, 0);
    assert.equal(collected, 10, 'all 10 grains ended up in a mouth — none lost or duplicated');
});

test('an unsynchronized shared counter can go wrong where a synchronized one cannot', async () => {
    const shared = guarded => `
        /*class*/class Counter extends Hamster {
            static int total = 0;
            Counter(int row) { super(row, 0, Hamster.OST, 0); }
            ${guarded ? 'static synchronized void bump()' : 'static void bump()'} {
                int seen = Counter.total;
                Counter.total = seen + 1;
            }
            public void run() {
                int i = 0;
                while (i < 6) { this.vor(); Counter.bump(); this.linksUm(); this.linksUm();
                                this.vor(); this.linksUm(); this.linksUm(); i = i + 1; }
            }
        }
    `;
    const program = `
        /*object-oriented program*/void main() {
            Counter a = new Counter(0);
            Counter b = new Counter(1);
            a.start();
            b.start();
        }
    `;
    const terrain = terrainFile(['>    ', '>    ', '     '], [0, 0], 0);

    // Protected: exact on every seed.
    for (let seed = 1; seed <= 10; seed++) {
        const run = await runSimulation({
            terrain, program, classModules: [shared(true)], seed,
        });
        assert.equal(run.status, 'finished');
        assert.equal(
            run.scheduler.threads()[0].state.staticFields.get('Counter').get('total'), 12,
            'the protected counter must be exact on seed ' + seed
        );
    }
});

test('a deadlocked concurrent program is reported, not left hanging', async () => {
    const run = await runSimulation({
        terrain: terrainFile(['>  ', '   '], [0], 0),
        classModules: [`
            /*class*/class Gate {
                public synchronized void waitForever() {
                    try { this.wait(); } catch (InterruptedException e) { }
                }
            }
        `, `
            /*class*/class Waiter extends Hamster {
                Gate gate;
                Waiter(Gate g) { super(0, 0, Hamster.OST, 0); this.gate = g; }
                public void run() { this.gate.waitForever(); }
            }
        `],
        program: `
            /*object-oriented program*/void main() {
                Gate gate = new Gate();
                Waiter w = new Waiter(gate);
                w.start();
            }
        `,
    });
    assert.equal(run.status, 'deadlocked');
    assert.match(run.report, /All hamsters are blocked/);
});

test('an uncaught error in one hamster does not stop the other from finishing its route', async () => {
    const run = await runSimulation({
        terrain: terrainFile(['>#   ', '>    ', '     '], [0, 0], 0),
        classModules: [`
            /*class*/class Walker extends Hamster {
                Walker(int row) { super(row, 0, Hamster.OST, 0); }
                public void run() { this.vor(); this.vor(); }
            }
        `],
        program: `
            /*object-oriented program*/void main() {
                Walker blocked = new Walker(0);
                Walker clear = new Walker(1);
                blocked.start();
                clear.start();
            }
        `,
    });
    assert.equal(run.status, 'finished');
    assert.equal(run.errors.length, 1, 'the hamster facing the wall died');
    assert.match(run.errors[0], /MauerDa|WallInFront/);
    const survivor = run.hamsters().find(h => h.y === 1 && h.id !== -1);
    assert.equal(survivor.x, 2, 'the other hamster completed both steps');
});
