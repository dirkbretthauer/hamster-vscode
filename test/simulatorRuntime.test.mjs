import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webviewDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'webview');

// The webview modules are ES modules inside a CommonJS package, so they are
// loaded as data: URLs with their relative imports rewritten to point at the
// already-loaded dependencies (the technique scripts/language-smoke.cjs uses).
function moduleUrl(source) {
    return 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
}

function readWebviewModule(relativePath, replacements = {}) {
    let source = fs.readFileSync(path.join(webviewDir, relativePath), 'utf8');
    for (const [specifier, url] of Object.entries(replacements)) {
        source = source.replaceAll(`'${specifier}'`, JSON.stringify(url));
    }
    return moduleUrl(source);
}

async function loadSimulatorRuntime() {
    const sharedStateUrl = readWebviewModule('shared/terrainEngineState.js');
    const engineUrl = readWebviewModule('simulator/engine.js', {
        '../shared/terrainEngineState.js': sharedStateUrl,
    });
    const runtimeUrl = readWebviewModule('simulator/runtime.js', {
        '../shared/terrainEngineState.js': sharedStateUrl,
        './engine.js': engineUrl,
    });
    const { createSimulatorEngine } = await import(engineUrl);
    const { createHamsterRuntime } = await import(runtimeUrl);
    const { engine, initEngine, getEngineState } = createSimulatorEngine();
    initEngine(5, 5);
    return createHamsterRuntime({
        engine,
        getEngineState,
        appendLog: () => {},
        readTerminalValue: () => 0,
    });
}

async function loadLanguageRunner() {
    const langDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'lang');
    const lexerUrl = moduleUrl(fs.readFileSync(path.join(langDir, 'hamster-lexer.js'), 'utf8'));
    const parserSource = fs.readFileSync(path.join(langDir, 'hamster-parser.js'), 'utf8')
        .replace("'./hamster-lexer.js'", JSON.stringify(lexerUrl));
    const parserUrl = moduleUrl(parserSource);
    const runnerSource = fs.readFileSync(path.join(langDir, 'hamster-runner.js'), 'utf8')
        .replace("'./hamster-parser.js'", JSON.stringify(parserUrl));
    return {
        parser: await import(parserUrl),
        runner: await import(moduleUrl(runnerSource)),
    };
}

test('collection classes expose the supported collection APIs', async () => {
    const runtime = await loadSimulatorRuntime();
    const list = runtime.createObject('ArrayList', []);
    assert.equal(runtime.callMethod(list, 'isEmpty', []), true);
    assert.equal(runtime.callMethod(list, 'add', ['first']), true);
    runtime.callMethod(list, 'add', [1, 'second']);
    assert.equal(runtime.callMethod(list, 'size', []), 2);
    assert.equal(runtime.callMethod(list, 'get', [1]), 'second');
    assert.equal(runtime.callMethod(list, 'remove', [0]), 'first');

    const map = runtime.createObject('java.util.HashMap', []);
    assert.equal(runtime.callMethod(map, 'put', [7, 'value']), null);
    assert.equal(runtime.callMethod(map, 'containsKey', [7]), true);
    assert.equal(runtime.callMethod(map, 'get', [7]), 'value');
    assert.equal(runtime.callMethod(map, 'remove', [7]), 'value');
    assert.equal(runtime.callMethod(map, 'get', [7]), null);

    const queue = runtime.createObject('LinkedList', []);
    assert.equal(runtime.callMethod(queue, 'offer', ['first']), true);
    assert.equal(runtime.callMethod(queue, 'offer', ['second']), true);
    assert.equal(runtime.callMethod(queue, 'poll', []), 'first');
    assert.equal(runtime.callMethod(queue, 'poll', []), 'second');
    assert.equal(runtime.callMethod(queue, 'poll', []), null);

    const set = runtime.createObject('HashSet', []);
    assert.equal(runtime.callMethod(set, 'add', ['item']), true);
    assert.equal(runtime.callMethod(set, 'add', ['item']), false);
    const iterator = runtime.callMethod(set, 'iterator', []);
    assert.equal(runtime.callMethod(iterator, 'hasNext', []), true);
    assert.equal(runtime.callMethod(iterator, 'next', []), 'item');
    assert.equal(runtime.callMethod(iterator, 'hasNext', []), false);
    assert.throws(
        () => runtime.callMethod(iterator, 'next', []),
        error => error.name === 'NoSuchElementException'
    );
});

test('unsupported collection methods report the collection and method', async () => {
    const runtime = await loadSimulatorRuntime();
    const list = runtime.createObject('ArrayList', []);
    assert.throws(
        () => runtime.callMethod(list, 'removeAll', []),
        /ArrayList\.removeAll: unsupported collection method/
    );
});

test('sets use user-defined equals and collections support enhanced-for', async () => {
    const { parser, runner } = await loadLanguageRunner();
    const runtime = await loadSimulatorRuntime();
    const source = `/*object-oriented program*/
        import java.util.HashSet;
        import java.util.Set;
        class Kachel {
            int row;
            Kachel(int row) { this.row = row; }
            boolean equals(Object other) {
                Kachel candidate = (Kachel) other;
                return this.row == candidate.row;
            }
        }
        class ActionStore extends java.util.Vector<Kachel> {}
        int visited;
        boolean found;
        int remaining;
        int vectorSize;
        void main() {
            Set<Kachel> cells = new HashSet<Kachel>();
            cells.add(new Kachel(1));
            cells.add(new Kachel(1));
            found = cells.contains(new Kachel(1));
            for (Kachel cell : cells) {
                visited++;
            }
            cells.remove(new Kachel(1));
            remaining = cells.size();
            ActionStore actions = new ActionStore();
            actions.add(new Kachel(2));
            vectorSize = actions.size();
        }`;
    const ast = parser.parseProgram(source, { compatibility: true, strict: true });
    const state = runner.createRunnerState(ast, runtime);
    while (runner.executeRunnerStep(state)) {}

    assert.equal(state.scopes[0].get('visited'), 1);
    assert.equal(state.scopes[0].get('found'), true);
    assert.equal(state.scopes[0].get('remaining'), 0);
    assert.equal(state.scopes[0].get('vectorSize'), 1);
});

// Thread and monitor operations are intercepted by the runner before they ever
// reach this adapter, because they must be able to block and the adapter is
// synchronous. These replace the assertions that used to pin the old
// "threads are not supported" errors.

test('the runtime adapter no longer rejects thread methods itself', async () => {
    const runtime = await loadSimulatorRuntime();
    const standardHamster = runtime.callBuiltin('Hamster.getStandardHamster', []);
    for (const method of ['start', 'join', 'interrupt']) {
        assert.doesNotThrow(
            () => { try { runtime.callMethod(standardHamster, method, []); } catch (error) {
                assert.doesNotMatch(error.message, /threads.*not supported/i);
            } },
            'the adapter must not raise the old thread-unsupported error for ' + method
        );
    }
});

test('monitor methods on a plain object are not rejected as unsupported threads', async () => {
    const runtime = await loadSimulatorRuntime();
    const nest = runtime.createObject('Object', []);
    for (const method of ['wait', 'notify', 'notifyAll']) {
        try {
            runtime.callMethod(nest, method, []);
        } catch (error) {
            assert.doesNotMatch(error.message, /threads.*not supported/i);
        }
    }
});

test('static Thread calls are not rejected by the adapter', async () => {
    const runtime = await loadSimulatorRuntime();
    try {
        runtime.callBuiltin('Thread.sleep', [10]);
    } catch (error) {
        assert.doesNotMatch(error.message, /threads.*not supported/i);
    }
});

test('hamster built-ins still work through the runtime adapter', async () => {
    const runtime = await loadSimulatorRuntime();
    const standardHamster = runtime.callBuiltin('Hamster.getStandardHamster', []);
    assert.equal(runtime.callMethod(standardHamster, 'getReihe', []), 0);
});

test('java.util.Random supports Java-compatible seeded nextInt(bound)', async () => {
    const runtime = await loadSimulatorRuntime();
    const first = runtime.createObject('Random', [1000]);
    const second = runtime.createObject('java.util.Random', [1000]);

    for (const expected of [7, 5, 6, 4, 2]) {
        assert.equal(runtime.callMethod(first, 'nextInt', [10]), expected);
        assert.equal(runtime.callMethod(second, 'nextInt', [10]), expected);
    }
});

test('Random.nextInt(bound) respects bounds and rejects non-positive bounds', async () => {
    const runtime = await loadSimulatorRuntime();
    const random = runtime.createObject('Random', [42]);

    assert.equal(runtime.callMethod(random, 'nextInt', [1]), 0);
    for (const bound of [2, 17, 2147483647]) {
        const value = runtime.callMethod(random, 'nextInt', [bound]);
        assert.ok(Number.isInteger(value));
        assert.ok(value >= 0 && value < bound, `expected ${value} to be in [0, ${bound})`);
    }
    for (const bound of [0, -1]) {
        assert.throws(
            () => runtime.callMethod(random, 'nextInt', [bound]),
            error => error.name === 'IllegalArgumentException' && error.message === 'bound must be positive'
        );
    }
});

test('the no-argument Random constructor and nextInt(bound) are available', async () => {
    const runtime = await loadSimulatorRuntime();
    const random = runtime.createObject('Random', []);

    const value = runtime.callMethod(random, 'nextInt', [37]);
    assert.ok(Number.isInteger(value));
    assert.ok(value >= 0 && value < 37);
});
