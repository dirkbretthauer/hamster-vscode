const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function moduleUrl(source) {
    return 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
}

async function loadLanguageModules() {
    const root = path.resolve(__dirname, '..');
    const lexerSource = fs.readFileSync(path.join(root, 'lang', 'hamster-lexer.js'), 'utf8');
    const lexerUrl = moduleUrl(lexerSource);
    const parserSource = fs.readFileSync(
        path.join(root, 'lang', 'hamster-parser.js'),
        'utf8'
    ).replace("'./hamster-lexer.js'", JSON.stringify(lexerUrl));
    const parserUrl = moduleUrl(parserSource);
    const runnerSource = fs.readFileSync(
        path.join(root, 'lang', 'hamster-runner.js'),
        'utf8'
    ).replace("'./hamster-parser.js'", JSON.stringify(parserUrl));
    return {
        parser: await import(parserUrl),
        runner: await import(moduleUrl(runnerSource)),
    };
}

function createRuntime(failures = new Set()) {
    const failureTypes = new Map([
        ['vor', 'WallInFrontException'],
        ['nimm', 'TileEmptyException'],
        ['gib', 'MouthEmptyException'],
    ]);
    function throwFailure(name) {
        const error = new Error('runtime failure from ' + name);
        error.hamsterExceptionType = failureTypes.get(name);
        throw error;
    }
    return {
        resolveIdentifier(name) {
            if (name === 'Hamster') return { __kind: 'class', name };
            return undefined;
        },
        callBuiltin(name) {
            if (failures.has(name)) {
                throwFailure(name);
            }
            return undefined;
        },
        callMethod(receiver, name) {
            if (failures.has(name)) {
                throwFailure(name);
            }
            if (receiver?.__kind === 'class' && name === 'getStandardHamster') {
                return { __kind: 'hamster', id: -1, className: 'Hamster' };
            }
            if (receiver?.__kind === 'hamster' && (name === 'init' || name === 'initialisiere')) {
                receiver.id = 0;
                return undefined;
            }
            if (receiver?.__kind === 'hamster' && name === 'linksUm') return undefined;
            if (receiver?.__kind === 'object' && receiver.className === 'Widget' &&
                name === 'doThing') return undefined;
            throw new Error('Unsupported method call: ' + name);
        },
        createObject(className) {
            if (className.endsWith('Hamster')) {
                return { __kind: 'hamster', id: null, className };
            }
            return {
                __kind: 'object',
                className,
                fields: Object.create(null),
            };
        },
    };
}

function runProgram(parser, runner, source, runtime = createRuntime()) {
    const ast = parser.parseProgram(source, { compatibility: true, strict: true });
    const state = runner.createRunnerState(ast, runtime);
    let steps = 0;
    while (runner.executeRunnerStep(state)) {
        assert.ok(++steps < 1000, 'program did not terminate');
    }
    return state;
}

(async () => {
    const { parser, runner } = await loadLanguageModules();

    function parses(source, options = {}) {
        return parser.parseProgram(source, { strict: true, ...options });
    }

    function parseFails(source, pattern) {
        let caught = null;
        try {
            parser.parseProgram(source, { strict: true });
        } catch (error) {
            caught = error;
        }
        assert.ok(caught, 'expected a parse error for: ' + source);
        assert.match(caught.message, pattern);
        return caught;
    }

    /** Walks an AST and returns the first node satisfying `predicate`, for asserting on nested shapes. */
    function findNode(node, predicate) {
        if (!node || typeof node !== 'object') return null;
        if (predicate(node)) return node;
        for (const value of Object.values(node)) {
            const children = Array.isArray(value) ? value : [value];
            for (const child of children) {
                const found = findNode(child, predicate);
                if (found) return found;
            }
        }
        return null;
    }

    assert.equal(
        parser.detectProgramType('void main() {}'),
        parser.ProgramType.Imperative
    );
    assert.equal(
        parser.detectProgramType('/*object-oriented program*/void main() {}'),
        parser.ProgramType.ObjectOriented
    );
    assert.equal(
        parser.detectProgramType('\uFEFF/*class*/class TestHamster extends Hamster {}'),
        parser.ProgramType.Class
    );
    assert.equal(
        parser.detectProgramType('/*python program*/vor()'),
        parser.ProgramType.Python
    );

    const imperativeProgram = parser.parseProgram(`
        /*imperative program*/
        void main() {
            vor();
        }
    `);
    assert.equal(imperativeProgram.programType, parser.ProgramType.Imperative);

    const objectProgram = parser.parseProgram(`
        /*object-oriented program*/
        class Helper {}
        void main() {
            Hamster hamster = new Hamster();
        }
    `);
    assert.equal(objectProgram.programType, parser.ProgramType.ObjectOriented);
    assert.equal(objectProgram.classes.length, 1);

    const classProgram = parser.parseProgram(`
        /*class*/
        class TestHamster extends Hamster {
            void turn() {
                linksUm();
            }
        }
    `, { strict: true });
    assert.equal(classProgram.programType, parser.ProgramType.Class);
    assert.equal(classProgram.classes.length, 1);
    assert.throws(
        () => parser.parseProgram('/*object-oriented program*/class Helper {}', { strict: true }),
        /Program must define void main/
    );
    assert.throws(
        () => parser.parseProgram('class Helper {}', { strict: true }),
        /Program must define void main/
    );
    assert.throws(
        () => parser.parseProgram('/*python program*/vor()'),
        /Program type 'python' is not supported/
    );
    assert.throws(
        () => parser.parseProgram('/*functional program*/void main() {}'),
        /Unsupported program type marker 'functional program'/
    );

    const helperBeforeMain = parser.parseProgram(`
        void helper() {
            vor();
        }
        void main() {
            helper();
        }
    `, { strict: true });
    assert.equal(helperBeforeMain.functions[0].name, 'helper');
    assert.deepEqual(helperBeforeMain.classes, []);

    const separateClassProgram = parser.parseProgram(`
        int result = 0;
        void main() {
            result = Helper.result();
        }
    `, { strict: true });
    const helperClassModule = parser.parseProgram(`
        /*class*/
        class Helper {
            static int result() {
                return 42;
            }
        }
    `, { strict: true });
    const separateClassState = runner.createRunnerState(
        separateClassProgram,
        createRuntime(),
        [helperClassModule]
    );
    assert.deepEqual(separateClassProgram.classes, []);
    assert.equal(separateClassState.ast, separateClassProgram);
    while (runner.executeRunnerStep(separateClassState)) {}
    assert.equal(separateClassState.scopes[0].get('result'), 42);

    const lazyInitializationProgram = parser.parseProgram(`
        int result = 0;
        void main() {
            result = Child.readChild();
            result = result + Child.readChild();
            Constructed instance = new Constructed();
        }
    `, { strict: true });
    const lazyClassSources = [
        `/*class*/ class Base {
            static int value = markBase();
        }`,
        `/*class*/ class Child extends Base {
            static int childValue = markChild();
            static int readChild() { return childValue; }
        }`,
        `/*class*/ class Constructed {
            static int value = markConstructed();
            Constructed() {}
        }`,
        `/*class*/ class Unused {
            static int value = markUnused();
        }`,
    ].map(source => parser.parseProgram(source, { requireMain: false, strict: true }));
    const initializationOrder = [];
    const lazyRuntime = createRuntime();
    const lazyCallBuiltin = lazyRuntime.callBuiltin;
    lazyRuntime.callBuiltin = name => {
        if (name.startsWith('mark')) {
            initializationOrder.push(name);
            return 10;
        }
        return lazyCallBuiltin(name);
    };
    const lazyInitializationState = runner.createRunnerState(
        lazyInitializationProgram,
        lazyRuntime,
        lazyClassSources
    );
    while (runner.executeRunnerStep(lazyInitializationState)) {}
    assert.deepEqual(initializationOrder, ['markBase', 'markChild', 'markConstructed']);
    assert.equal(lazyInitializationState.scopes[0].get('result'), 20);
    assert.equal(lazyInitializationState.classInitialization.get('Unused').status, 'uninitialized');

    const incompleteProgram = parser.parseProgram('int result = 1;', {
        requireMain: false,
    });
    assert.equal(incompleteProgram.globals.length, 1);

    const expressionProgram = parser.parseProgram(`
        int doubled(int value) {
            return value * 2;
        }
        void main() {}
    `, { strict: true });
    const expressionState = runner.createRunnerState(expressionProgram, createRuntime());
    expressionState.scopes.push(new Map([['value', 4], ['items', [2, 3, 5]]]));
    expressionState.frames.push({
        name: 'main',
        scopeIndex: 1,
        loc: { line: 5, column: 9 },
    });
    assert.equal(
        runner.evaluateExpression(
            parser.parseExpression('doubled(value) + items[1]'),
            expressionState,
            1
        ),
        11
    );
    assert.equal(
        runner.evaluateExpression(
            parser.parseExpression('value > 3 && items.length == 3'),
            expressionState,
            1
        ),
        true
    );
    expressionState.scopes.push(new Map([['value', 9]]));
    expressionState.frames.push({
        name: 'doubled',
        scopeIndex: 2,
        loc: { line: 2, column: 9 },
    });
    assert.equal(
        runner.evaluateExpression(parser.parseExpression('value'), expressionState, 1),
        4
    );
    assert.equal(
        runner.evaluateExpression(parser.parseExpression('value'), expressionState, 2),
        9
    );
    assert.throws(
        () => runner.evaluateExpression(parser.parseExpression('value++'), expressionState, 1),
        /only supports read-only expressions/
    );
    assert.equal(expressionState.scopes[1].get('value'), 4);
    assert.throws(
        () => parser.parseExpression('value trailing'),
        /Unexpected token after expression/
    );

    const isolatedEvaluationProgram = parser.parseProgram(`
        int counter = 1;
        int increment() {
            counter++;
            return counter;
        }
        int moveAndRead() {
            vor();
            return counter;
        }
        int waitForValue() {
            return waitValue();
        }
        int loopForever() {
            while (true) {}
            return 0;
        }
        void main() {}
    `, { strict: true });
    let runtimeCalls = 0;
    const isolatedRuntime = createRuntime();
    isolatedRuntime.callBuiltin = name => {
        runtimeCalls += 1;
        if (name === 'waitValue') {
            throw new runner.RunnerPause('value needed');
        }
        return undefined;
    };
    const isolatedState = runner.createRunnerState(isolatedEvaluationProgram, isolatedRuntime);
    isolatedState.frames.push({ name: 'main', scopeIndex: 1, loc: { line: 17, column: 9 } });
    isolatedState.scopes.push(new Map());
    assert.equal(
        runner.evaluateExpression(parser.parseExpression('increment()'), isolatedState),
        2
    );
    assert.equal(isolatedState.scopes[0].get('counter'), 1);
    assert.throws(
        () => runner.evaluateExpression(parser.parseExpression('moveAndRead()'), isolatedState),
        /cannot execute hamster instructions/
    );
    assert.equal(runtimeCalls, 0);
    const frameCount = isolatedState.frames.length;
    const scopeCount = isolatedState.scopes.length;
    assert.throws(
        () => runner.evaluateExpression(parser.parseExpression('waitForValue()'), isolatedState),
        /cannot request terminal input/
    );
    assert.equal(isolatedState.frames.length, frameCount);
    assert.equal(isolatedState.scopes.length, scopeCount);
    assert.throws(
        () => runner.evaluateExpression(parser.parseExpression('loopForever()'), isolatedState),
        /exceeded the step limit/
    );

    const syntaxErrors = parser.collectProgramErrors(`
        void main() {
            int first = ;
            int second = ;
        }
    `, { requireMain: false });
    assert.equal(syntaxErrors.length, 2);
    assert.equal(syntaxErrors[0].token.value, ';');
    assert.equal(syntaxErrors[0].token.length, 1);
    assert.equal(syntaxErrors[1].token.value, ';');

    const tokenLengthError = parser.collectProgramErrors(
        'void main() { int value duplicate; }',
        { requireMain: false }
    );
    assert.equal(tokenLengthError[0].token.value, 'duplicate');
    assert.equal(tokenLengthError[0].token.length, 'duplicate'.length);

    const lexerErrors = parser.collectProgramErrors(`
        void main() {
            @
            #
        }
    `, { requireMain: false });
    assert.equal(lexerErrors.filter(error => error.name === 'HamsterLexerError').length, 2);

    const switchErrors = parser.collectProgramErrors(`
        void main() {
            switch (1) {
                case 0:
                    int value = ;
                    break;
            }
            vor();
        }
    `, { requireMain: false });
    assert.equal(switchErrors.length, 1);
    assert.match(switchErrors[0].message, /Unexpected token in expression/);

    const unterminatedStringErrors = parser.collectProgramErrors(`
        void main() {
            String value = "unterminated
            int second = ;
        }
    `, { requireMain: false });
    assert.equal(
        unterminatedStringErrors.filter(error => error.name === 'HamsterLexerError').length,
        1
    );
    assert.ok(unterminatedStringErrors.some(error => error.token?.line === 4));

    const malformedFunctionErrors = parser.collectProgramErrors(`
        void main( {
            vor();
        }
        void helper( {
            linksUm();
        }
    `, { requireMain: false });
    assert.equal(malformedFunctionErrors.length, 2);
    assert.ok(malformedFunctionErrors.every(error => /Expected type keyword/.test(error.message)));

    assert.throws(
        () => parser.parseProgram(`
            void main() {
                int first = ;
                int second = ;
            }
        `, { requireMain: false, strict: true }),
        error => error.token?.line === 3
    );

    assert.deepEqual(
        parser.collectProgramErrors('void main() { vor(); }', { requireMain: false }),
        []
    );

    const breakpointAst = parser.parseProgram([
        'void main() {',
        '    // comment',
        '    int grains = 0;',
        '    if (grains == 0) {',
        '        vor();',
        '    }',
        '}',
    ].join('\n'));
    assert.deepEqual(parser.collectExecutableLines(breakpointAst), [3, 4, 5]);
    assert.equal(parser.findExecutableLineAtOrAfter(1, [3, 4, 5]), 3);
    assert.equal(parser.findExecutableLineAtOrAfter(4, [3, 4, 5]), 4);
    assert.equal(parser.findExecutableLineAtOrAfter(6, [3, 4, 5]), null);

    const classBreakpointAst = parser.parseProgram([
        '/*class*/',
        'class Outer {',
        '    int field = 1;',
        '    void run() {',
        '        linksUm();',
        '    }',
        '    class Inner {',
        '        void nested() {',
        '            vor();',
        '        }',
        '    }',
        '}',
    ].join('\n'));
    assert.deepEqual(parser.collectExecutableLines(classBreakpointAst), [5, 9]);

    const switchState = runProgram(parser, runner, `
        int result = 0;
        void main() {
            int i = 0;
            while (i < 2) {
                switch (i) {
                    case 0:
                        result = result + 1;
                        break;
                    default:
                        result = result + 10;
                }
                result = result + 100;
                i = i + 1;
            }
            switch (2) {
                case 1:
                    result = result + 1000;
                case 2:
                    result = result + 2;
                case 3:
                    result = result + 3;
                    break;
                default:
                    result = result + 1000;
            }
            switch (2) {
                default:
                    result = result + 1000;
                case 2:
                    result = result + 5;
                    break;
            }
        }
    `);
    assert.equal(switchState.scopes[0].get('result'), 221);

    const runtimeObjectState = runProgram(parser, runner, `
        int calls = 0;
        void main() {
            Hamster hamster = new Hamster();
            hamster.init(0, 0, 0, 0);
            hamster.linksUm();
            Hamster standard = Hamster.getStandardHamster();
            standard.linksUm();
            Widget widget = new Widget();
            widget.doThing();
            calls = 4;
        }
    `);
    assert.equal(runtimeObjectState.scopes[0].get('calls'), 4);

    const exceptionState = runProgram(parser, runner, `
        class CustomException extends HamsterException {
            CustomException(String message) {
                super(message);
            }
        }
        int aliasCaught = 0;
        int customCaught = 0;
        int valueCaught = 0;
        int crossCallCaught = 0;
        String customMessage = "";
        void fail() {
            throw new CustomException("custom");
        }
        void main() {
            try {
                throw new WallInFrontException();
            } catch (MauerDaException error) {
                aliasCaught = 1;
            }
            try {
                throw new CustomException("custom");
            } catch (HamsterException error) {
                customCaught = 1;
                customMessage = error.getMessage();
            }
            try {
                throw "user value";
            } catch (String error) {
                valueCaught = 1;
            }
            try {
                fail();
            } catch (HamsterException error) {
                crossCallCaught = 1;
            }
        }
    `);
    assert.equal(exceptionState.scopes[0].get('aliasCaught'), 1);
    assert.equal(exceptionState.scopes[0].get('customCaught'), 1);
    assert.equal(exceptionState.scopes[0].get('valueCaught'), 1);
    assert.equal(exceptionState.scopes[0].get('crossCallCaught'), 1);
    assert.equal(exceptionState.scopes[0].get('customMessage'), 'custom');
    assert.equal(exceptionState.scopes.length, 1);

    const builtinState = runProgram(
        parser,
        runner,
        `
            int failures = 0;
            String message = "";
            void main() {
                try { vor(); } catch (MauerDaException error) {
                    failures = failures + 1;
                    message = error.getMessage();
                }
                try { nimm(); } catch (KachelLeerException error) {
                    failures = failures + 1;
                }
                try { gib(); } catch (MaulLeerException error) {
                    failures = failures + 1;
                }
            }
        `,
        createRuntime(new Set(['vor', 'nimm', 'gib']))
    );
    assert.equal(builtinState.scopes[0].get('failures'), 3);
    assert.match(builtinState.scopes[0].get('message'), /runtime failure from vor/);

    assert.throws(
        () => runProgram(parser, runner, `
            void main() {
                String text = "not a hamster";
                try {
                    text.vor();
                } catch (MauerDaException error) {
                    return;
                }
            }
        `),
        /Unsupported method call: vor/
    );

    const loopState = runProgram(parser, runner, `
        int loopResult = 0;
        void main() {
            while (true) {
                loopResult = loopResult + 1;
                break;
                loopResult = 100;
            }
            for (int i = 0; i < 5; i++) {
                if (i == 2) break;
                loopResult = loopResult + i;
            }
            while (true) {
                try {
                    throw "stop";
                } catch (String error) {
                    break;
                }
            }
        }
    `);
    assert.equal(loopState.scopes[0].get('loopResult'), 2);

    const inheritedBuiltinState = runProgram(
        parser,
        runner,
        `
            class TestHamster extends Hamster {
                void trigger() {
                    try { vor(); } catch (WallInFrontException error) {
                        inheritedCaught = 1;
                    }
                }
            }
            int inheritedCaught = 0;
            void main() {
                TestHamster hamster = new TestHamster();
                hamster.trigger();
            }
        `,
        createRuntime(new Set(['vor']))
    );
    assert.equal(inheritedBuiltinState.scopes[0].get('inheritedCaught'), 1);

    assert.throws(
        () => runProgram(parser, runner, `
            void main() {
                throw new MouthEmptyException("empty");
            }
        `),
        error => error instanceof runner.HamsterLanguageException &&
            error.name === 'MouthEmptyException' &&
            error.message.includes('empty')
    );

    let inputAttempts = 0;
    const pauseRuntime = createRuntime();
    pauseRuntime.callBuiltin = name => {
        if (name === 'readInt' && inputAttempts++ === 0) {
            throw new runner.RunnerPause('number needed');
        }
        return 7;
    };
    const pauseAst = parser.parseProgram(`
        int value = 0;
        void main() { value = readInt(); }
    `, { compatibility: true, strict: true });
    const pauseState = runner.createRunnerState(pauseAst, pauseRuntime);
    assert.equal(runner.executeRunnerStep(pauseState), true);
    assert.throws(
        () => runner.executeRunnerStep(pauseState),
        error => error instanceof runner.RunnerPause && error.message === 'number needed'
    );
    while (runner.executeRunnerStep(pauseState)) {}
    assert.equal(pauseState.scopes[0].get('value'), 7);

    assert.throws(
        () => parser.parseProgram('void main() { break; }'),
        /break is only valid inside a loop or switch/
    );
    // ── try with multiple catch clauses and finally (US1, T009) ──
    const isTry = node => node.type === parser.ASTNodeType.TryStatement;
    const multiCatchTry = findNode(parses('void main() { try {} catch (A a) {} catch (B b) {} }'), isTry);
    assert.equal(multiCatchTry.handlers.length, 2);
    assert.ok(multiCatchTry.handlers.every(handler => handler.type === parser.ASTNodeType.CatchClause));
    assert.deepEqual(multiCatchTry.handlers.map(handler => handler.paramType), ['A', 'B']);
    assert.deepEqual(multiCatchTry.handlers.map(handler => handler.paramName), ['a', 'b']);
    assert.equal(multiCatchTry.finalizer, null);
    const catchFinallyTry = findNode(parses('void main() { try {} catch (A a) {} finally {} }'), isTry);
    assert.equal(catchFinallyTry.handlers.length, 1);
    assert.equal(catchFinallyTry.finalizer.type, parser.ASTNodeType.Block);
    const finallyOnlyTry = findNode(parses('void main() { try {} finally {} }'), isTry);
    assert.equal(finallyOnlyTry.handlers.length, 0);
    assert.equal(finallyOnlyTry.finalizer.type, parser.ASTNodeType.Block);
    parses('void main() { try {} catch (final A a) {} }');
    parseFails('void main() { try {} }', /Expected catch or finally after try block/);
    assert.deepEqual(parser.collectExecutableLines(parses([
        'void main() {',
        '    try {',
        '        vor();',
        '    } catch (A a) {',
        '        linksUm();',
        '    } catch (B b) {',
        '        nimm();',
        '    } finally {',
        '        gib();',
        '    }',
        '}',
    ].join('\n'))), [2, 3, 5, 7, 9]);

    const arrayState = runProgram(parser, runner, `
        int[] counts = null;
        boolean[][] visited = null;
        int[][] jagged = null;
        String[] names = null;
        int total = 0;
        void main() {
            counts = new int[3];
            visited = new boolean[2][3];
            jagged = new int[2][];
            names = new String[2];
            counts[1] = counts[1] + 5;
            visited[1][2] = true;
            jagged[0] = new int[1];
            total = counts[0] + counts[1] + jagged[0][0];
        }
    `);
    assert.deepEqual(arrayState.scopes[0].get('counts'), [0, 5, 0]);
    assert.deepEqual(arrayState.scopes[0].get('visited'), [[false, false, false], [false, false, true]]);
    assert.deepEqual(arrayState.scopes[0].get('jagged'), [[0], null]);
    assert.deepEqual(arrayState.scopes[0].get('names'), [null, null]);
    assert.equal(arrayState.scopes[0].get('total'), 5);
    assert.throws(
        () => parser.parseProgram('void main() { int x = new int; }'),
        /Expected array dimension after new int/
    );

    assert.equal(parser.parseExpression('(a) + b').type, parser.ASTNodeType.BinaryExpression);
    assert.equal(parser.parseExpression('(a) - 1').type, parser.ASTNodeType.BinaryExpression);
    assert.equal(parser.parseExpression('(int) -x').type, parser.ASTNodeType.CastExpression);
    assert.equal(parser.parseExpression('(a.b.Type[]) x').targetType, 'a.b.Type');
    assert.equal(parser.parseExpression('((Base) b).value()').type, parser.ASTNodeType.CallExpression);

    const castRuntime = createRuntime();
    // Mirrors the webview runtime, which resolves capitalized names to class references.
    castRuntime.resolveIdentifier = name => (name === 'Math' ? { __kind: 'class', name } : undefined);
    castRuntime.callMethod = (receiver, name) => {
        if (receiver?.name === 'Math' && name === 'random') return 0.75;
        throw new Error('Unsupported method call: ' + name);
    };
    const castState = runProgram(parser, runner, `
        interface Marker {}
        class Base {
            int value() { return 1; }
        }
        class Derived extends Base implements Marker {
            int value() { return 2; }
        }
        class Other {}
        int randomValue = 0;
        int negativeValue = 0;
        int derivedValue = 0;
        int castCaught = 0;
        boolean interfaceCast = false;
        boolean nullCast = false;
        void main() {
            randomValue = (int) (Math.random() * 4);
            negativeValue = (int) -(Math.random() * 4);
            Base base = new Derived();
            derivedValue = ((Derived) base).value() + ((Base) base).value();
            Marker marker = (Marker) base;
            interfaceCast = marker == base;
            Object unknown = (Integer) base;
            Other none = (Other) null;
            nullCast = none == null;
            try {
                Other other = (Other) base;
            } catch (ClassCastException error) {
                castCaught = 1;
            }
        }
    `, castRuntime);
    assert.equal(castState.scopes[0].get('randomValue'), 3);
    assert.equal(castState.scopes[0].get('negativeValue'), -3);
    assert.equal(castState.scopes[0].get('derivedValue'), 4);
    assert.equal(castState.scopes[0].get('interfaceCast'), true);
    assert.equal(castState.scopes[0].get('nullCast'), true);
    assert.equal(castState.scopes[0].get('castCaught'), 1);

    // ── Generics (US1, T007) ──
    const genericLocalProgram = parses(`
        void main() {
            Speicher<Integer> k = new Speicher<Integer>();
        }
    `);
    const genericLocal = findNode(genericLocalProgram, node => node.type === 'VariableDeclaration' && node.name === 'k');
    assert.equal(genericLocal.varType, 'Speicher');
    assert.equal(genericLocal.initializer.callee.name, 'Speicher');
    const genericClassProgram = parses(`
        /*class*/
        class Pair<K, V> {
            private Array<Pair<K, V>> entries;
            Pair<K, V> get(Array<? super T> a, Box<?> b, Box<? extends Hamster> c) { return null; }
            public static <T> void replace(Array<? super T> array, T obj) {}
            Object convert(Object obj) { return (Speicher<Integer>) obj; }
            Object make() { return new Box<>(); }
        }
        class Box<T extends Hamster> {}
        class Summe implements Callable<Integer> {}
    `);
    const [pairClass, boxClass, summeClass] = genericClassProgram.classes;
    assert.deepEqual(pairClass.typeParameters, ['K', 'V']);
    assert.equal(pairClass.fields[0].varType, 'Array');
    const pairGet = pairClass.methods.find(method => method.name === 'get');
    assert.equal(pairGet.returnType, 'Pair');
    assert.deepEqual(pairGet.parameters.map(parameter => parameter.paramType), ['Array', 'Box', 'Box']);
    assert.deepEqual(pairGet.typeParameters, []);
    assert.deepEqual(pairClass.methods.find(method => method.name === 'replace').typeParameters, ['T']);
    assert.equal(findNode(pairClass, node => node.type === 'CastExpression').targetType, 'Speicher');
    assert.equal(findNode(pairClass, node => node.type === 'NewExpression').callee.name, 'Box');
    assert.deepEqual(boxClass.typeParameters, ['T']);
    assert.deepEqual(summeClass.interfaces, ['Callable']);
    assert.deepEqual(summeClass.typeParameters, []);
    const genericInterface = parses('/*class*/public interface Callable<V> {}').classes[0];
    assert.equal(genericInterface.type, parser.ASTNodeType.InterfaceDecl);
    assert.deepEqual(genericInterface.typeParameters, ['V']);
    assert.equal(parses('Speicher<Integer> s = null; void main() {}').globals[0].varType, 'Speicher');
    parseFails('void main() { Speicher<> k = null; }', /Unexpected token in expression/);
    assert.equal(parser.parseExpression('a < b').type, parser.ASTNodeType.BinaryExpression);
    assert.equal(parser.parseExpression('i < n && j > m').operator, '&&');
    assert.equal(parser.parseExpression('x < y == z').operator, '==');

    // ── synchronized (US1, T008) ──
    const synchronizedProgram = parses([
        '/*class*/',
        'class Lager {',
        '    synchronized static void f() {}',
        '    public synchronized void g() {}',
        '    synchronized void put(ErzeugerHamster ham) {}',
        '    void aufStabWarten() {',
        '        synchronized (Territorium.getKachel(this.getReihe(),',
        '                this.getSpalte())) {',
        '            vor();',
        '        }',
        '    }',
        '}',
    ].join('\n'));
    const lagerMethods = synchronizedProgram.classes[0].methods;
    assert.equal(lagerMethods.length, 4);
    assert.ok(['synchronized', 'static'].every(modifier => lagerMethods[0].modifiers.includes(modifier)));
    assert.ok(lagerMethods[1].modifiers.includes('synchronized'));
    const synchronizedBlock = findNode(lagerMethods[3], node => node.type === parser.ASTNodeType.SynchronizedStatement);
    assert.ok(synchronizedBlock, 'synchronized block should parse to a SynchronizedStatement');
    assert.equal(synchronizedBlock.lock.type, parser.ASTNodeType.CallExpression);
    assert.deepEqual(parser.collectExecutableLines(synchronizedProgram), [7, 9]);

    // ── Diagnostics stay precise around the new constructs (US1, T012) ──
    const errorsAt = lines => parser.collectProgramErrors(lines.join('\n'), { requireMain: false });
    assert.ok(errorsAt([
        'void main() {',
        '    try {',
        '        vor();',
        '    } finally {',
        '        gib();',
        '}',
    ]).length > 0, 'missing } after finally block must be reported');
    for (const brokenLine of ['    Speicher<Integer k;', '    try {} catch () {}', '    synchronized () {}']) {
        const errors = errorsAt(['void main() {', brokenLine, '}']);
        assert.ok(errors.some(error => error.token?.line === 2), 'expected an error on line 2 for: ' + brokenLine);
    }

    // ── Runtime: multiple catch clauses (US2, T021) ──
    const multiCatchState = runProgram(parser, runner, `
        int specific = 0;
        int second = 0;
        int general = 0;
        void main() {
            try { throw new KachelLeerException("x"); }
            catch (KachelLeerException e) { specific = specific + 1; }
            catch (HamsterException e) { general = general + 100; }
            try { throw new MauerDaException("x"); }
            catch (KachelLeerException e) { specific = specific + 100; }
            catch (MauerDaException e) { second = second + 1; }
            try { throw new KachelLeerException("x"); }
            catch (HamsterException e) { general = general + 1; }
            catch (KachelLeerException e) { specific = specific + 100; }
        }
    `);
    assert.equal(multiCatchState.scopes[0].get('specific'), 1);
    assert.equal(multiCatchState.scopes[0].get('second'), 1);
    assert.equal(multiCatchState.scopes[0].get('general'), 1);
    assert.throws(
        () => runProgram(parser, runner, `
            void main() {
                try { throw new MauerDaException("w"); }
                catch (KachelLeerException e) {}
                catch (MaulLeerException e) {}
            }
        `),
        error => error instanceof runner.HamsterLanguageException && error.name === 'MauerDaException'
    );

    // ── Runtime: finally on every exit path (US2, T022, T028) ──
    const finallyState = runProgram(parser, runner, `
        int count = 0;
        int caughtAt = 0;
        int returned = 0;
        int loops = 0;
        int overridden = 0;
        int replaced = 0;
        String order = "";
        int returnFromTry() {
            try { return 7; } finally { count = count + 1; }
        }
        int finallyOverrides() {
            try { return 1; } finally { return 2; }
        }
        void main() {
            try { vor(); } finally { count = count + 1; }
            try { throw new HamsterException("a"); }
            catch (HamsterException e) { caughtAt = count; }
            finally { count = count + 1; }
            returned = returnFromTry();
            while (true) {
                try { loops = loops + 1; break; } finally { count = count + 1; }
            }
            overridden = finallyOverrides();
            try {
                try { throw new HamsterException("inner"); }
                finally { throw new MauerDaException("replacement"); }
            } catch (MauerDaException e) { replaced = replaced + 1; }
            try {
                try { count = count + 0; }
                finally { throw new MauerDaException("after normal"); }
            } catch (MauerDaException e) { replaced = replaced + 1; }
            try {} finally { count = count + 1; }
            try {
                try { throw new HamsterException("nested"); }
                finally { order = order + "inner"; }
            } catch (HamsterException e) { order = order + "-catch"; }
            finally { order = order + "-outer"; }
        }
    `);
    const finallyGlobals = finallyState.scopes[0];
    assert.equal(finallyGlobals.get('count'), 5);
    assert.equal(finallyGlobals.get('caughtAt'), 1);
    assert.equal(finallyGlobals.get('returned'), 7);
    assert.equal(finallyGlobals.get('loops'), 1);
    assert.equal(finallyGlobals.get('overridden'), 2);
    assert.equal(finallyGlobals.get('replaced'), 2);
    assert.equal(finallyGlobals.get('order'), 'inner-catch-outer');
    assert.equal(finallyState.scopes.length, 1);
    const uncaughtFinallyState = runner.createRunnerState(parses(`
        int count = 0;
        void main() {
            try { throw new MauerDaException("u"); } finally { count = count + 1; }
        }
    `), createRuntime());
    assert.throws(
        () => { while (runner.executeRunnerStep(uncaughtFinallyState)) {} },
        error => error instanceof runner.HamsterLanguageException && error.name === 'MauerDaException'
    );
    assert.equal(uncaughtFinallyState.scopes[0].get('count'), 1);

    // ── Runtime: generics are erased (US3, T030) ──
    const genericRuntimeSource = `
        class Box<T> {
            T value;
            T empty;
            Box(T v) { value = v; }
            T get() { return value; }
            T getEmpty() { return empty; }
        }
        class Util {
            static <T> T first(Box<T> box) { return box.get(); }
        }
        int fromInt = 0;
        int fromStatic = 0;
        boolean emptyIsNull = false;
        void main() {
            Box<Integer> ints = new Box<Integer>(5);
            fromInt = ints.get();
            fromStatic = Util.first(ints);
            Box<Box<Integer>> boxes = new Box<Box<Integer>>(ints);
            emptyIsNull = boxes.getEmpty() == null;
        }
    `;
    let erasedRuntimeSource = genericRuntimeSource;
    while (/<[^<>]*>/.test(erasedRuntimeSource)) {
        erasedRuntimeSource = erasedRuntimeSource.replace(/<[^<>]*>/g, '');
    }
    const genericResults = ['fromInt', 'fromStatic', 'emptyIsNull']
        .map(name => runProgram(parser, runner, genericRuntimeSource).scopes[0].get(name));
    const erasedResults = ['fromInt', 'fromStatic', 'emptyIsNull']
        .map(name => runProgram(parser, runner, erasedRuntimeSource).scopes[0].get(name));
    assert.deepEqual(genericResults, [5, 5, true]);
    assert.deepEqual(genericResults, erasedResults);

    // ── Runtime: synchronized (US3, T031) ──
    const synchronizedState = runProgram(parser, runner, `
        class Counter {
            synchronized void inc() { methodCalls = methodCalls + 1; }
        }
        int locks = 0;
        int bodies = 0;
        int fromReturn = 0;
        int afterBreak = 0;
        int methodCalls = 0;
        Object lock() {
            locks = locks + 1;
            return new Object();
        }
        int guarded() {
            synchronized (lock()) { return 42; }
        }
        void main() {
            for (int i = 0; i < 3; i++) {
                synchronized (lock()) { bodies = bodies + 1; }
            }
            fromReturn = guarded();
            while (true) {
                synchronized (lock()) { break; }
            }
            afterBreak = 1;
            new Counter().inc();
        }
    `);
    const synchronizedGlobals = synchronizedState.scopes[0];
    assert.equal(synchronizedGlobals.get('locks'), 5);
    assert.equal(synchronizedGlobals.get('bodies'), 3);
    assert.equal(synchronizedGlobals.get('fromReturn'), 42);
    assert.equal(synchronizedGlobals.get('afterBreak'), 1);
    assert.equal(synchronizedGlobals.get('methodCalls'), 1);
    assert.throws(
        () => runProgram(parser, runner, 'void main() { synchronized (null) {} }'),
        /Cannot synchronize on null/
    );

    console.log('Language smoke checks passed');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
