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

test('calling a method on an unprovided library class names the class', async () => {
    const runtime = await loadSimulatorRuntime();
    const list = runtime.createObject('ArrayList', []);
    assert.throws(
        () => runtime.callMethod(list, 'add', [1]),
        /ArrayList\.add: class ArrayList is not provided by the Hamster simulator/
    );
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
