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

async function loadSimulatorRuntime(options = {}) {
    const sharedStateUrl = readWebviewModule('shared/terrainEngineState.js');
    const javaTimeUrl = readWebviewModule('simulator/javaTime.js');
    const engineUrl = readWebviewModule('simulator/engine.js', {
        '../shared/terrainEngineState.js': sharedStateUrl,
    });
    const runtimeUrl = readWebviewModule('simulator/runtime.js', {
        '../shared/terrainEngineState.js': sharedStateUrl,
        './engine.js': engineUrl,
        './javaTime.js': javaTimeUrl,
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
        ...options,
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

test('uncaught array bounds failures carry the index expression source location', async () => {
    const { parser, runner } = await loadLanguageRunner();
    for (const expression of ['a[5] = 1;', 'int value = a[5];']) {
        const ast = parser.parseProgram(`void main() {
    int[] a = new int[1];
    ${expression}
}`);
        const state = runner.createRunnerState(ast, await loadSimulatorRuntime());
        assert.throws(() => {
            while (!state.finished) runner.executeRunnerStep(state);
        }, error => {
            assert.ok(error instanceof runner.HamsterLanguageException);
            assert.equal(error.name, 'ArrayIndexOutOfBoundsException');
            assert.equal(error.line, 3);
            assert.ok(error.column > 0);
            assert.equal(error.loc.line, 3);
            assert.match(error.message, /Index 5 out of bounds for length 1/);
            return true;
        });
    }
});

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

test('Stack supports LIFO operations, top-relative search and inherited Vector APIs', async () => {
    const runtime = await loadSimulatorRuntime();
    for (const className of ['Stack', 'java.util.Stack']) {
        const stack = runtime.createObject(className, []);
        const call = (method, ...args) => runtime.callMethod(stack, method, args);
        assert.equal(call('empty'), true);
        assert.equal(call('isEmpty'), true);
        assert.equal(call('size'), 0);
        assert.equal(call('search', 'missing'), -1);
        for (const method of ['pop', 'peek']) {
            assert.throws(() => call(method), error =>
                error.name === 'EmptyStackException' &&
                error.hamsterExceptionType === 'EmptyStackException');
        }

        assert.equal(call('push', 'first'), 'first');
        assert.equal(call('push', 'second'), 'second');
        assert.equal(call('push', 'first'), 'first');
        assert.equal(call('empty'), false);
        assert.equal(call('isEmpty'), false);
        assert.equal(call('size'), 3);
        assert.equal(call('peek'), 'first');
        assert.equal(call('size'), 3);
        assert.equal(call('search', 'first'), 1);
        assert.equal(call('search', 'second'), 2);
        assert.equal(call('search', 'missing'), -1);
        assert.equal(call('indexOf', 'first'), 0);
        assert.equal(call('contains', 'second'), true);
        const iterator = call('iterator');
        for (const value of ['first', 'second', 'first']) {
            assert.equal(runtime.callMethod(iterator, 'hasNext', []), true);
            assert.equal(runtime.callMethod(iterator, 'next', []), value);
        }
        assert.equal(runtime.callMethod(iterator, 'hasNext', []), false);
        assert.equal(call('pop'), 'first');
        assert.equal(call('pop'), 'second');
        assert.equal(call('pop'), 'first');
        assert.equal(call('empty'), true);
        assert.equal(call('push', null), null);
        assert.equal(call('peek'), null);
        assert.equal(call('search', null), 1);
        assert.equal(call('pop'), null);

        assert.equal(call('add', 'bottom'), true);
        call('add', 1, 'top');
        assert.equal(call('get', 0), 'bottom');
        assert.equal(call('remove', 0), 'bottom');
        assert.equal(call('pop'), 'top');
        for (const [method, args] of [['get', [0]], ['remove', [-1]], ['add', [1, 'bad']]]) {
            assert.throws(() => call(method, ...args), error =>
                error.hamsterExceptionType === 'ArrayIndexOutOfBoundsException');
        }
        call('push', 'cleared');
        call('clear');
        assert.equal(call('empty'), true);
        assert.throws(() => call('push'), /expects 1 argument/);
        assert.throws(() => call('search'), /expects 1 argument/);
        assert.throws(() => call('peek', 1), /expects 0 arguments/);
    }
});

test('AtomicBoolean supports atomic reads, writes, swaps, and compare-and-set', async () => {
    const runtime = await loadSimulatorRuntime();
    for (const className of ['AtomicBoolean', 'java.util.concurrent.atomic.AtomicBoolean']) {
        const atomic = runtime.createObject(className, [false]);
        const call = (method, ...args) => runtime.callMethod(atomic, method, args);
        assert.equal(call('get'), false);
        assert.equal(call('compareAndSet', true, true), false);
        assert.equal(call('get'), false);
        assert.equal(call('compareAndSet', false, true), true);
        assert.equal(call('get'), true);
        assert.equal(call('getAndSet', false), true);
        assert.equal(call('get'), false);
        assert.equal(call('set', true), undefined);
        assert.equal(call('get'), true);
    }
});

test('Semaphore and ReentrantLock constructors validate their arguments', async () => {
    const runtime = await loadSimulatorRuntime();
    assert.throws(() => runtime.createObject('Semaphore', [-1]), error =>
        error.name === 'IllegalArgumentException' &&
        error.hamsterExceptionType === 'IllegalArgumentException');
    assert.throws(() => runtime.createObject('Semaphore', []), /expects permits/);
    assert.throws(() => runtime.createObject('ReentrantLock', [true, false]), /at most one/);
});

test('Hamster copy construction preserves state without sharing the engine hamster', async () => {
    const runtime = await loadSimulatorRuntime();
    const source = runtime.createObject('Hamster', [2, 3, 0, 4, 5]);
    const copy = runtime.createObject('Hamster', [source]);
    assert.notEqual(copy.id, source.id);
    for (const [method, expected] of [
        ['getReihe', 2], ['getSpalte', 3], ['getBlickrichtung', 0], ['getAnzahlKoerner', 4],
    ]) {
        assert.equal(runtime.callMethod(copy, method, []), expected);
    }
    runtime.callMethod(copy, 'gib', []);
    assert.equal(runtime.callMethod(copy, 'getAnzahlKoerner', []), 3);
    assert.equal(runtime.callMethod(source, 'getAnzahlKoerner', []), 4);
    const uninitialized = runtime.createObject('Hamster', []);
    const uninitializedCopy = runtime.createObject('Hamster', [uninitialized]);
    assert.equal(uninitializedCopy.id, null);
    assert.throws(() => runtime.callMethod(uninitializedCopy, 'vor', []),
        error => error.hamsterExceptionType === 'HamsterNotInitializedException');
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
            int hashCode() { return this.row; }
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

async function runCollectionProgram(body) {
    const { parser, runner } = await loadLanguageRunner();
    const runtime = await loadSimulatorRuntime();
    const source = `/*object-oriented program*/
        import java.util.*;
        class Kachel {
            int row;
            Kachel(int row) { this.row = row; }
            boolean equals(Object other) { return this.row == ((Kachel) other).row; }
            int hashCode() { return this.row; }
        }
        class EqualsOnly {
            int row;
            EqualsOnly(int row) { this.row = row; }
            boolean equals(Object other) { return this.row == ((EqualsOnly) other).row; }
        }
        ${body}`;
    const ast = parser.parseProgram(source, { compatibility: true, strict: true });
    const state = runner.createRunnerState(ast, runtime);
    while (runner.executeRunnerStep(state)) {}
    return state.scopes[0];
}

test('Stack search uses equals from the top and inherits list equality operations', async () => {
    const globals = await runCollectionProgram(`
        int nearest;
        int bottom;
        int missing;
        int nullDistance;
        int firstIndex;
        boolean contained;
        boolean removed;
        int popped;
        void main() {
            Stack<Kachel> stack = new Stack<Kachel>();
            stack.push(new Kachel(1));
            stack.push(new Kachel(2));
            stack.push(new Kachel(2));
            nearest = stack.search(new Kachel(2));
            bottom = stack.search(new Kachel(1));
            missing = stack.search(new Kachel(9));
            stack.push(null);
            nullDistance = stack.search(null);
            stack.pop();
            firstIndex = stack.indexOf(new Kachel(2));
            contained = stack.contains(new Kachel(1));
            removed = stack.remove(new Kachel(1));
            popped = stack.pop().row;
        }`);

    assert.equal(globals.get('nearest'), 1);
    assert.equal(globals.get('bottom'), 3);
    assert.equal(globals.get('missing'), -1);
    assert.equal(globals.get('nullDistance'), 1);
    assert.equal(globals.get('firstIndex'), 1);
    assert.equal(globals.get('contained'), true);
    assert.equal(globals.get('removed'), true);
    assert.equal(globals.get('popped'), 2);
});

test('Stack failures are catchable as EmptyStackException and RuntimeException', async () => {
    const globals = await runCollectionProgram(`
        boolean popCaught;
        boolean runtimeCaught;
        boolean peekCaught;
        boolean indexCaught;
        void main() {
            Stack<String> stack = new Stack<String>();
            try { stack.pop(); } catch (EmptyStackException e) { popCaught = true; }
            try { stack.pop(); } catch (RuntimeException e) { runtimeCaught = true; }
            try { stack.peek(); } catch (EmptyStackException e) { peekCaught = true; }
            try { stack.get(0); } catch (ArrayIndexOutOfBoundsException e) { indexCaught = true; }
        }`);

    for (const name of ['popCaught', 'runtimeCaught', 'peekCaught', 'indexCaught']) {
        assert.equal(globals.get(name), true, name);
    }
});

test('Stack and user subclasses iterate bottom-to-top and support super calls', async () => {
    const globals = await runCollectionProgram(`
        class CellStack extends java.util.Stack<Kachel> {
            Kachel push(Kachel cell) { return super.push(cell); }
            int search(Kachel cell) { return super.search(cell); }
            Kachel pop() { return super.pop(); }
        }
        class DerivedStack extends CellStack {}
        int stackOrder;
        int subclassOrder;
        int subclassSearch;
        int subclassTop;
        int pushed;
        int remaining;
        void main() {
            Stack<Integer> stack = new Stack<Integer>();
            stack.push(1);
            stack.push(2);
            stack.push(3);
            for (int value : stack) { stackOrder = stackOrder * 10 + value; }
            DerivedStack cells = new DerivedStack();
            pushed = cells.push(new Kachel(4)).row;
            cells.add(0, new Kachel(3));
            cells.push(new Kachel(5));
            for (Kachel cell : cells) { subclassOrder = subclassOrder * 10 + cell.row; }
            subclassSearch = cells.search(new Kachel(4));
            subclassTop = cells.pop().row;
            remaining = cells.size();
        }`);

    assert.equal(globals.get('stackOrder'), 123);
    assert.equal(globals.get('subclassOrder'), 345);
    assert.equal(globals.get('subclassSearch'), 2);
    assert.equal(globals.get('subclassTop'), 5);
    assert.equal(globals.get('pushed'), 4);
    assert.equal(globals.get('remaining'), 2);
});

test('collection and Random failures are catchable Java exceptions', async () => {
    const globals = await runCollectionProgram(`
        class AktionsSpeicher extends java.util.Vector<String> {
            String naechste() {
                try { return this.remove(0); } catch (ArrayIndexOutOfBoundsException exc) { return null; }
            }
        }
        boolean vectorReturnedNull;
        boolean listCaught;
        boolean randomCaught;
        boolean iteratorCaught;
        boolean vectorCaughtAsRuntime;
        void main() {
            vectorReturnedNull = new AktionsSpeicher().naechste() == null;
            try { new ArrayList<String>().get(0); } catch (IndexOutOfBoundsException e) { listCaught = true; }
            try { new Random(1).nextInt(0); } catch (IllegalArgumentException e) { randomCaught = true; }
            try { new HashSet<String>().iterator().next(); } catch (NoSuchElementException e) { iteratorCaught = true; }
            try { new Vector<String>().get(3); } catch (RuntimeException e) { vectorCaughtAsRuntime = true; }
        }`);

    assert.equal(globals.get('vectorReturnedNull'), true);
    assert.equal(globals.get('listCaught'), true);
    assert.equal(globals.get('randomCaught'), true);
    assert.equal(globals.get('iteratorCaught'), true);
    assert.equal(globals.get('vectorCaughtAsRuntime'), true);
});

test('List.remove(Object), indexOf and contains use equals while remove(int) stays positional', async () => {
    const globals = await runCollectionProgram(`
        int foundAt;
        int missingAt;
        boolean contained;
        boolean removedByObject;
        boolean removedMissing;
        int removedByIndex;
        int remainingSize;
        void main() {
            Vector<Kachel> warteliste = new Vector<Kachel>();
            warteliste.add(new Kachel(1));
            warteliste.add(new Kachel(2));
            warteliste.add(new Kachel(3));
            foundAt = warteliste.indexOf(new Kachel(2));
            missingAt = warteliste.indexOf(new Kachel(9));
            contained = warteliste.contains(new Kachel(3));
            removedByObject = warteliste.remove(new Kachel(1));
            removedMissing = warteliste.remove(new Kachel(9));
            removedByIndex = warteliste.remove(1).row;
            remainingSize = warteliste.size();
        }`);

    assert.equal(globals.get('foundAt'), 1);
    assert.equal(globals.get('missingAt'), -1);
    assert.equal(globals.get('contained'), true);
    assert.equal(globals.get('removedByObject'), true);
    assert.equal(globals.get('removedMissing'), false);
    assert.equal(globals.get('removedByIndex'), 3);
    assert.equal(globals.get('remainingSize'), 1);
});

test('HashMap keys match through user-defined equals and hashCode', async () => {
    const globals = await runCollectionProgram(`
        int previous;
        int size;
        boolean hasKey;
        int value;
        int removed;
        int sizeAfterRemove;
        void main() {
            HashMap<Kachel, Integer> map = new HashMap<Kachel, Integer>();
            map.put(new Kachel(1), 5);
            previous = map.put(new Kachel(1), 6);
            size = map.size();
            hasKey = map.containsKey(new Kachel(1));
            value = map.get(new Kachel(1));
            removed = map.remove(new Kachel(1));
            sizeAfterRemove = map.size();
        }`);

    assert.equal(globals.get('previous'), 5);
    assert.equal(globals.get('size'), 1);
    assert.equal(globals.get('hasKey'), true);
    assert.equal(globals.get('value'), 6);
    assert.equal(globals.get('removed'), 6);
    assert.equal(globals.get('sizeAfterRemove'), 0);
});

test('HashSet needs hashCode as well as equals, including through super.add', async () => {
    const globals = await runCollectionProgram(`
        class KachelSet extends HashSet<Kachel> {
            int additions;
            boolean add(Kachel kachel) {
                this.additions++;
                return super.add(kachel);
            }
        }
        int equalsOnlySize;
        boolean equalsOnlyContains;
        int subclassSize;
        int subclassAdditions;
        boolean secondAddResult;
        void main() {
            HashSet<EqualsOnly> equalsOnly = new HashSet<EqualsOnly>();
            equalsOnly.add(new EqualsOnly(1));
            equalsOnly.add(new EqualsOnly(1));
            equalsOnlySize = equalsOnly.size();
            equalsOnlyContains = equalsOnly.contains(new EqualsOnly(1));

            KachelSet cells = new KachelSet();
            cells.add(new Kachel(1));
            secondAddResult = cells.add(new Kachel(1));
            subclassSize = cells.size();
            subclassAdditions = cells.additions;
        }`);

    assert.equal(globals.get('equalsOnlySize'), 2);
    assert.equal(globals.get('equalsOnlyContains'), false);
    assert.equal(globals.get('secondAddResult'), false);
    assert.equal(globals.get('subclassSize'), 1);
    assert.equal(globals.get('subclassAdditions'), 2);
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

test('Date and Calendar read the runtime clock and implement Calendar field arithmetic', async () => {
    const start = new Date(2024, 0, 31, 8, 30, 15).getTime();
    const runtime = await loadSimulatorRuntime({ currentTimeMillis: () => start });

    const date = runtime.createObject('Date', []);
    assert.equal(runtime.callMethod(date, 'getTime', []), start);

    const calendar = runtime.callBuiltin('Calendar.getInstance', []);
    const field = (name) => runtime.getMember({ __kind: 'class', name: 'Calendar' }, name);
    assert.equal(runtime.callMethod(calendar, 'get', [field('HOUR_OF_DAY')]), 8);
    assert.equal(runtime.callMethod(calendar, 'get', [field('MONTH')]), field('JANUARY'));

    runtime.callMethod(calendar, 'add', [field('MONTH'), 1]);
    assert.equal(runtime.callMethod(calendar, 'get', [field('DAY_OF_MONTH')]), 29, 'Jan 31 + 1 month clamps to Feb 29');
    runtime.callMethod(calendar, 'add', [field('HOUR_OF_DAY'), 20]);
    assert.equal(runtime.callMethod(calendar, 'get', [field('DAY_OF_MONTH')]), 1, 'hours roll over into March');
    assert.equal(runtime.callMethod(calendar, 'get', [field('MONTH')]), field('MARCH'));

    const later = runtime.callMethod(calendar, 'getTime', []);
    assert.equal(runtime.callMethod(later, 'after', [date]), true);
    assert.equal(runtime.callMethod(calendar, 'getTimeInMillis', []), runtime.callMethod(later, 'getTime', []));

    runtime.setClock(() => start + 1000);
    assert.equal(runtime.callBuiltin('System.currentTimeMillis', []), start + 1000);
});
