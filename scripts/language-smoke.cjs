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

    const incompleteProgram = parser.parseProgram('int result = 1;', {
        requireMain: false,
    });
    assert.equal(incompleteProgram.globals.length, 1);

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
    assert.throws(
        () => parser.parseProgram(`
            void main() {
                try {} catch (Exception first) {} catch (Exception second) {}
            }
        `),
        /Multiple catch clauses are not supported/
    );
    assert.throws(
        () => parser.parseProgram('void main() { try {} catch (Exception e) {} finally {} }'),
        /finally clauses are not supported/
    );
    assert.throws(
        () => parser.parseProgram('void main() { try {} finally {} }'),
        /finally clauses are not supported/
    );

    console.log('Language smoke checks passed');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
