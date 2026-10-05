import { ASTNodeType } from './hamster-parser.js';

export class RunnerPause extends Error {
    constructor(message = 'Runner paused') {
        super(message);
        this.name = 'RunnerPause';
    }
}

// ---------------------------------------------------------------------------
// Internal signal for return statements inside generator-based execution.
// ---------------------------------------------------------------------------
class ReturnSignal {
    constructor(value) {
        this.value = value;
    }
}

class BreakSignal {}

export class HamsterLanguageException extends Error {
    constructor(value) {
        const typeName = exceptionTypeName(value);
        const detail = value?.message ? ': ' + value.message : '';
        super(typeName + detail);
        this.name = typeName;
        this.value = value;
    }
}

const BUILTIN_EXCEPTION_SUPERTYPES = new Map([
    ['WallInFrontException', 'MauerDaException'],
    ['MauerDaException', 'HamsterException'],
    ['TileEmptyException', 'KachelLeerException'],
    ['KachelLeerException', 'HamsterException'],
    ['MouthEmptyException', 'MaulLeerException'],
    ['MaulLeerException', 'HamsterException'],
    ['HamsterInitializationException', 'HamsterInitialisierungsException'],
    ['HamsterInitialisierungsException', 'HamsterException'],
    ['HamsterNotInitializedException', 'HamsterNichtInitialisiertException'],
    ['HamsterNichtInitialisiertException', 'HamsterException'],
    ['HamsterException', 'RuntimeException'],
    ['ClassCastException', 'RuntimeException'],
    ['RuntimeException', 'Exception'],
    ['Exception', 'Throwable'],
    ['Throwable', 'Object'],
]);

// ---------------------------------------------------------------------------
// Hamster instructions that constitute breakpoints (mode A1/B).
// One step = one hamster instruction.  Everything else executes invisibly.
// ---------------------------------------------------------------------------
const HAMSTER_INSTRUCTIONS = new Set([
    'vor', 'linksUm', 'nimm', 'gib',
    'vornFrei', 'kornDa', 'maulLeer',
    'move', 'turnLeft', 'pickGrain', 'putGrain',
    'frontIsClear', 'grainAvailable', 'mouthEmpty',
    'getReihe', 'getSpalte', 'getBlickrichtung',
    'getAnzahlKoerner', 'anzahlKoerner',
    'getRow', 'getColumn', 'getDirection', 'getNumberOfGrains',
    'schreib', 'write',
    'readInt', 'readNumber', 'readString',
    'liesZahl', 'liesZeichenkette', 'liesString',
    'createHamster',
    'init', 'initialisiere',
    'rechtsUm',
]);

const DEBUG_EVALUATION_STEP_LIMIT = 10000;

const JAVA_INT_MIN = -2147483648;
const JAVA_INT_MAX = 2147483647;
const NATIVE_HAMSTER_CLASS = 'Hamster';

function isHamsterInstruction(name) {
    return HAMSTER_INSTRUCTIONS.has(name);
}

const KNOWN_BUILTINS = new Set([
    'vor',
    'linksUm',
    'nimm',
    'gib',
    'vornFrei',
    'kornDa',
    'maulLeer',
    'move',
    'turnLeft',
    'pickGrain',
    'putGrain',
    'frontIsClear',
    'grainAvailable',
    'mouthEmpty',
    'getReihe',
    'getSpalte',
    'getBlickrichtung',
    'getAnzahlKoerner',
    'anzahlKoerner',
    'getRow',
    'getColumn',
    'getDirection',
    'getNumberOfGrains',
    'createHamster',
    'init',
    'initialisiere',
    'schreib',
    'write',
    'liesZahl',
    'liesZeichenkette',
    'liesString',
    'readInt',
    'readNumber',
    'readString',
]);

function isKnownBuiltinName(name) {
    if (KNOWN_BUILTINS.has(name)) return true;
    if (name === 'Math.random') return true;
    return false;
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API – createRunnerState / executeRunnerStep
// ═══════════════════════════════════════════════════════════════════════════

export function createRunnerState(ast, runtime, classModules = []) {
    const functions = new Map();
    for (const fn of ast.functions || []) {
        if (!functions.has(fn.name)) {
            functions.set(fn.name, []);
        }
        functions.get(fn.name).push(fn);
    }
    const classes = new Map();
    const staticFields = new Map();
    const staticInitializers = [];
    const staticInitializersByClass = new Map();
    const classInitialization = new Map();
    const declarations = [
        ...(ast.classes || []),
        ...classModules.flatMap(moduleAst => moduleAst.classes || []),
    ];
    for (const declaration of flattenClassDeclarations(declarations)) {
        if (classes.has(declaration.name)) {
            throw new Error('Duplicate class or interface name: ' + declaration.name);
        }
        classes.set(declaration.name, declaration);
        classInitialization.set(declaration.name, { status: 'uninitialized', error: null });
        const classFields = new Map();
        const classStaticInitializers = [];
        for (const field of declaration.fields || []) {
            if ((field.modifiers || []).includes('static')) {
                classFields.set(field.name, defaultValueForType(field.varType));
                if (field.initializer) {
                    classStaticInitializers.push({
                        className: declaration.name,
                        kind: 'field',
                        order: field.order,
                        field,
                    });
                }
            }
        }
        staticFields.set(declaration.name, classFields);
        for (const initializer of declaration.initializerBlocks || []) {
            if (initializer.isStatic) {
                classStaticInitializers.push({
                    className: declaration.name,
                    kind: 'block',
                    order: initializer.order,
                    body: initializer.body,
                });
            }
        }
        classStaticInitializers.sort((left, right) => left.order - right.order);
        staticInitializersByClass.set(declaration.name, classStaticInitializers);
        staticInitializers.push(...classStaticInitializers);
    }
    const main = selectMainFunction(functions.get('main') || []);
    if (!runtime || typeof runtime.callBuiltin !== 'function') {
        throw new Error('Runner runtime must provide callBuiltin(name, args, functions)');
    }

    const state = {
        ast,
        functions,
        classes,
        staticFields,
        staticInitializers,
        staticInitializersByClass,
        classInitialization,
        runtime,
        finished: false,
        scopes: [new Map()],
        // Legacy stack field kept for backward-compatible state inspection.
        stack: [],
        // Call frames for debugger integration. Each entry:
        //   { name, loc, scopeIndex, callerLoc }
        // The root frame (main) is pushed by programGenerator.
        frames: [],
        generator: null,
    };

    // Initialize global variables into the root scope before main runs.
    for (const g of ast.globals || []) {
        let value = defaultValueForType(g.varType);
        if (g.initializer && g.initializer.type === ASTNodeType.Literal) {
            value = g.initializer.value;
        }
        state.scopes[0].set(g.name, value);
    }

    state.generator = programGenerator(state, main);
    return state;
}

/**
 * Advance execution.
 *
 * `opts.granularity`:
 *   - 'instruction' (default): stop only on hamster instructions and user
 *     function-call sites. Used by the simulator's Run/Step buttons.
 *   - 'statement': also stop on every non-block statement. Used by the
 *     VS Code debugger so users can step through control flow / assignments.
 *
 * Returns `true` if the program has more work, `false` when finished.
 * Throws `RunnerPause` when the program needs terminal input.
 */
export function executeRunnerStep(state, opts) {
    if (state.finished || !state.generator) return false;
    const granularity = (opts && opts.granularity) || 'instruction';

    while (true) {
        const result = state.generator.next();
        if (result.done) {
            state.finished = true;
            return false;
        }

        const yielded = result.value;
        if (yielded && yielded.kind === 'needsInput') {
            throw new RunnerPause(yielded.message || 'Waiting for input');
        }

        // In coarse 'instruction' mode, swallow statement-level yields so
        // visible stepping stays at one-hamster-instruction-per-step.
        if (granularity === 'instruction' && yielded && yielded.kind === 'statement') {
            continue;
        }

        state.lastInstruction = yielded || null;
        return true;
    }
}

export function evaluateExpression(node, state, frameId) {
    validateDebuggerExpression(node);
    const evaluationState = stateForEvaluation(state, frameId);
    const generator = evalExpressionGen(node, evaluationState, 0);
    let yieldedSteps = 0;
    try {
        while (true) {
            if (++yieldedSteps > DEBUG_EVALUATION_STEP_LIMIT) {
                throw new Error('Debugger evaluation exceeded the step limit');
            }
            const result = generator.next();
            if (result.done) {
                return result.value;
            }
            if (result.value?.kind === 'needsInput') {
                throw new Error('Debugger evaluation cannot request terminal input');
            }
            if (result.value?.kind === 'instruction') {
                throw new Error('Debugger evaluation cannot execute hamster instructions');
            }
        }
    } finally {
        if (typeof generator.return === 'function') {
            generator.return();
        }
    }
}

function stateForEvaluation(state, frameId) {
    let frameIndex = state.frames.length - 1;
    if (frameId != null) {
        frameIndex = Number(frameId) - 1;
        if (!Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex >= state.frames.length) {
            throw new Error('Unknown stack frame: ' + frameId);
        }
    }
    const nextFrame = state.frames[frameIndex + 1];
    const scopeEnd = nextFrame ? nextFrame.scopeIndex : state.scopes.length;
    const seen = new Map();
    return {
        ...state,
        scopes: state.scopes.slice(0, scopeEnd).map(scope => cloneEvaluationValue(scope, seen)),
        frames: state.frames.slice(0, Math.max(0, frameIndex + 1)),
        staticFields: cloneEvaluationValue(state.staticFields, seen),
        evaluationStepsRemaining: DEBUG_EVALUATION_STEP_LIMIT,
    };
}

function cloneEvaluationValue(value, seen) {
    if (value == null || typeof value !== 'object') {
        return value;
    }
    if (seen.has(value)) {
        return seen.get(value);
    }
    if (value instanceof Map) {
        const clone = new Map();
        seen.set(value, clone);
        for (const [key, entry] of value) {
            clone.set(key, cloneEvaluationValue(entry, seen));
        }
        return clone;
    }
    if (Array.isArray(value)) {
        const clone = [];
        seen.set(value, clone);
        for (const entry of value) {
            clone.push(cloneEvaluationValue(entry, seen));
        }
        return clone;
    }
    const clone = Object.create(Object.getPrototypeOf(value));
    seen.set(value, clone);
    for (const key of Object.keys(value)) {
        clone[key] = cloneEvaluationValue(value[key], seen);
    }
    return clone;
}

function validateDebuggerExpression(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === ASTNodeType.PrefixExpression ||
        node.type === ASTNodeType.PostfixExpression ||
        node.type === ASTNodeType.NewExpression) {
        throw new Error('Debugger evaluation only supports read-only expressions');
    }
    for (const value of Object.values(node)) {
        if (Array.isArray(value)) {
            value.forEach(validateDebuggerExpression);
        } else if (value && typeof value === 'object' && value.type) {
            validateDebuggerExpression(value);
        }
    }
}

function consumeEvaluationStep(state) {
    if (state.evaluationStepsRemaining == null) return;
    state.evaluationStepsRemaining -= 1;
    if (state.evaluationStepsRemaining < 0) {
        throw new Error('Debugger evaluation exceeded the step limit');
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Generator-based interpreter (matches original mode A1/B)
//
// The generator yields a { kind, name } descriptor after every hamster
// instruction.  Non-hamster statements (variable decls, control flow,
// arithmetic, user-defined functions) execute transparently without yielding.
// ═══════════════════════════════════════════════════════════════════════════

function* programGenerator(state, mainFn) {
    const isInstanceMain = mainFn.owner && !(mainFn.modifiers || []).includes('static');
    if (isInstanceMain) {
        try {
            const receiver = yield* instantiateClassGen(
                mainFn.owner, [], state, 0, mainFn.loc || null
            );
            yield* invokeUserFunctionGen(mainFn, [], state, 1, receiver, mainFn.owner);
        } finally {
            state.finished = true;
        }
        return;
    }
    state.frames.push({
        name: 'main',
        loc: mainFn.loc || null,
        scopeIndex: state.scopes.length,
        callerLoc: null,
        className: mainFn.owner || null,
    });
    try {
        yield* executeStatementGen(mainFn.body, state, 0);
    } finally {
        state.frames.pop();
        state.finished = true;
    }
}

function* initializeClassGen(state, className, callDepth, loc) {
    const declaration = state.classes.get(className);
    if (!declaration) return;
    const initialization = state.classInitialization.get(className);
    if (initialization.status === 'initialized' || initialization.status === 'initializing') return;
    if (initialization.status === 'failed') throw initialization.error;

    initialization.status = 'initializing';
    try {
        if (declaration.superClass && state.classes.has(declaration.superClass)) {
            yield* initializeClassGen(state, declaration.superClass, callDepth + 1, loc);
        }
        for (const initializer of state.staticInitializersByClass.get(className) || []) {
            const initializerLoc = initializer.field?.loc || initializer.body?.loc || loc || null;
            state.frames.push({
                name: '<static>',
                loc: initializerLoc,
                scopeIndex: state.scopes.length,
                callerLoc: loc || null,
                className,
            });
            try {
                if (initializer.kind === 'field') {
                    state.staticFields.get(className).set(
                        initializer.field.name,
                        yield* evalExpressionGen(initializer.field.initializer, state, callDepth + 1)
                    );
                } else {
                    const result = yield* executeStatementGen(initializer.body, state, callDepth + 1);
                    if (result instanceof ReturnSignal) {
                        throw new Error('Static initializer blocks cannot return');
                    }
                }
            } finally {
                state.frames.pop();
            }
        }
        initialization.status = 'initialized';
    } catch (error) {
        initialization.status = 'failed';
        initialization.error = error;
        throw error;
    }
}

// ---------------------------------------------------------------------------
// Statement generator – returns undefined or ReturnSignal
// ---------------------------------------------------------------------------
function* executeStatementGen(node, state, callDepth) {
    if (!node) return undefined;
    consumeEvaluationStep(state);

    // Statement-level yield – swallowed by the runner in 'instruction'
    // granularity mode, but observed by the debugger in 'statement' mode so
    // users can step through ifs, loops, assignments, etc.
    // Blocks are transparent: only their contained statements yield.
    if (node.type !== ASTNodeType.Block && node.loc) {
        yield { kind: 'statement', name: node.type, loc: node.loc };
    }

    switch (node.type) {
        case ASTNodeType.Block: {
            state.scopes.push(new Map());
            try {
                for (const stmt of node.statements || []) {
                    const result = yield* executeStatementGen(stmt, state, callDepth);
                    if (isControlSignal(result)) return result;
                }
            } finally {
                if (state.scopes.length > 1) state.scopes.pop();
            }
            return undefined;
        }

        case ASTNodeType.IfStatement: {
            const cond = truthy(yield* evalExpressionGen(node.test, state, callDepth));
            if (cond) {
                return yield* executeStatementGen(node.consequent, state, callDepth);
            } else if (node.alternate) {
                return yield* executeStatementGen(node.alternate, state, callDepth);
            }
            return undefined;
        }

        case ASTNodeType.WhileStatement: {
            let guard = 0;
            while (truthy(yield* evalExpressionGen(node.test, state, callDepth))) {
                if (++guard > 100000) throw new Error('Loop iteration limit exceeded');
                const result = yield* executeStatementGen(node.body, state, callDepth);
                if (result instanceof BreakSignal) return undefined;
                if (result instanceof ReturnSignal) return result;
            }
            return undefined;
        }

        case ASTNodeType.DoWhileStatement: {
            let guard = 0;
            do {
                if (++guard > 100000) throw new Error('Loop iteration limit exceeded');
                const result = yield* executeStatementGen(node.body, state, callDepth);
                if (result instanceof BreakSignal) return undefined;
                if (result instanceof ReturnSignal) return result;
            } while (truthy(yield* evalExpressionGen(node.test, state, callDepth)));
            return undefined;
        }

        case ASTNodeType.ForStatement:
            throw new Error('For statements are not supported at runtime');

        case ASTNodeType.SwitchStatement: {
            const discriminant = yield* evalExpressionGen(node.discriminant, state, callDepth);
            let startIndex = -1;
            let defaultIndex = -1;
            for (let i = 0; i < node.cases.length; i++) {
                const switchCase = node.cases[i];
                if (!switchCase.test) {
                    defaultIndex = i;
                    continue;
                }
                const caseValue = yield* evalExpressionGen(switchCase.test, state, callDepth);
                if (javaEquals(discriminant, caseValue)) {
                    startIndex = i;
                    break;
                }
            }
            if (startIndex < 0) startIndex = defaultIndex;
            state.scopes.push(new Map());
            try {
                for (let i = startIndex; i >= 0 && i < node.cases.length; i++) {
                    for (const statement of node.cases[i].statements || []) {
                        const result = yield* executeStatementGen(statement, state, callDepth);
                        if (result instanceof BreakSignal) return undefined;
                        if (result instanceof ReturnSignal) return result;
                    }
                }
            } finally {
                state.scopes.pop();
            }
            return undefined;
        }

        case ASTNodeType.BreakStatement:
            return new BreakSignal();

        case ASTNodeType.TryStatement:
            return yield* executeTryStatementGen(node, state, callDepth);

        case ASTNodeType.SynchronizedStatement: {
            // The runner is single-threaded, so mutual exclusion holds without a real lock.
            const lock = yield* evalExpressionGen(node.lock, state, callDepth);
            if (lock == null) {
                throw new Error('Cannot synchronize on null');
            }
            return yield* executeStatementGen(node.body, state, callDepth);
        }

        case ASTNodeType.ThrowStatement: {
            const value = yield* evalExpressionGen(node.argument, state, callDepth);
            throw new HamsterLanguageException(value);
        }

        case ASTNodeType.VariableDecl: {
            let value = defaultValueForType(node.varType);
            if (node.initializer) {
                value = yield* evalExpressionGen(node.initializer, state, callDepth);
            }
            declareVariable(state, node.name, value);
            return undefined;
        }

        case ASTNodeType.Assignment: {
            const reference = yield* resolveAssignmentTargetGen(
                state, node.target ?? null, node.name, callDepth
            );
            const operator = node.operator || '=';
            const current = operator === '=' ? undefined : reference.get();
            const right = yield* evalExpressionGen(node.value, state, callDepth);
            reference.set(applyAssignmentOperator(operator, current, right));
            return undefined;
        }

        case ASTNodeType.ExpressionStmt:
            yield* evalExpressionGen(node.expression, state, callDepth);
            return undefined;

        case ASTNodeType.ReturnStatement: {
            const value = node.argument
                ? yield* evalExpressionGen(node.argument, state, callDepth)
                : undefined;
            return new ReturnSignal(value);
        }

        default:
            throw new Error('Unsupported statement type: ' + node.type);
    }
}

/**
 * Java `try`/`catch`/`finally`. Outcomes are captured explicitly rather than
 * with a JavaScript `finally` around `yield*`: closing a suspended generator
 * (e.g. when the debugger cleans up an evaluation) would otherwise run the
 * program's own finally blocks.
 */
function* executeTryStatementGen(node, state, callDepth) {
    let outcome = yield* captureOutcomeGen(executeStatementGen(node.block, state, callDepth));
    if (outcome.threw && outcome.error instanceof HamsterLanguageException) {
        const handler = node.handlers.find(candidate =>
            exceptionMatchesType(outcome.error.value, candidate.paramType, state)
        );
        if (handler) {
            outcome = yield* captureOutcomeGen(
                executeCatchClauseGen(handler, outcome.error.value, state, callDepth)
            );
        }
    }
    if (node.finalizer) {
        // A finally block that completes abruptly replaces the try/catch outcome.
        const finalizerOutcome = yield* captureOutcomeGen(
            executeStatementGen(node.finalizer, state, callDepth)
        );
        if (finalizerOutcome.threw) throw finalizerOutcome.error;
        if (isControlSignal(finalizerOutcome.value)) return finalizerOutcome.value;
    }
    if (outcome.threw) throw outcome.error;
    return outcome.value;
}

function* captureOutcomeGen(generator) {
    try {
        return { threw: false, value: yield* generator };
    } catch (error) {
        return { threw: true, error };
    }
}

function* executeCatchClauseGen(handler, exceptionValue, state, callDepth) {
    state.scopes.push(new Map([[handler.paramName, exceptionValue]]));
    try {
        return yield* executeStatementGen(handler.body, state, callDepth);
    } finally {
        state.scopes.pop();
    }
}

// ---------------------------------------------------------------------------
// Expression generator – returns the evaluated value.
// Yields only when a hamster instruction is encountered inside a call.
// ---------------------------------------------------------------------------
function* evalExpressionGen(node, state, callDepth) {
    consumeEvaluationStep(state);
    switch (node.type) {
        case ASTNodeType.Literal:
            return node.value;

        case ASTNodeType.Identifier:
            return resolveIdentifierValue(state, node.name);

        case ASTNodeType.MemberExpression:
            return yield* evalMemberExpressionGen(node, state, callDepth);

        case ASTNodeType.IndexExpression:
            return yield* evalIndexExpressionGen(node, state, callDepth);

        case ASTNodeType.NewExpression:
            return yield* evalNewExpressionGen(node, state, callDepth);

        case ASTNodeType.ThisExpression:
            return getVariable(state, 'this');

        case ASTNodeType.SuperExpression:
            throw new Error('super can only be used for constructor or method calls');

        case ASTNodeType.UnaryExpression: {
            const value = yield* evalExpressionGen(node.argument, state, callDepth);
            if (node.operator === '!') return !truthy(value);
            if (node.operator === '-') return -Number(value);
            throw new Error('Unsupported unary operator: ' + node.operator);
        }

        case ASTNodeType.PrefixExpression: {
            if (node.operator !== '--' && node.operator !== '++') {
                throw new Error('Unsupported prefix operator: ' + node.operator);
            }
            const reference = yield* resolveAssignmentTargetGen(state, node.argument, null, callDepth);
            const delta = node.operator === '++' ? 1 : -1;
            const updated = Number(reference.get()) + delta;
            reference.set(updated);
            return updated;
        }

        case ASTNodeType.PostfixExpression: {
            if (node.operator !== '--' && node.operator !== '++') {
                throw new Error('Unsupported postfix operator: ' + node.operator);
            }
            const reference = yield* resolveAssignmentTargetGen(state, node.argument, null, callDepth);
            const current = Number(reference.get());
            const delta = node.operator === '++' ? 1 : -1;
            reference.set(current + delta);
            return current;
        }

        case ASTNodeType.CastExpression:
            return castValue(yield* evalExpressionGen(node.argument, state, callDepth), node, state);

        case ASTNodeType.BinaryExpression:
            return yield* evalBinaryExpressionGen(node, state, callDepth);

        case ASTNodeType.ConditionalExpression: {
            const test = yield* evalExpressionGen(node.test, state, callDepth);
            return truthy(test)
                ? yield* evalExpressionGen(node.consequent, state, callDepth)
                : yield* evalExpressionGen(node.alternate, state, callDepth);
        }

        case ASTNodeType.CallExpression:
            return yield* evalCallExpressionGen(node, state, callDepth);

        default:
            throw new Error('Unsupported expression type: ' + node.type);
    }
}

// ---------------------------------------------------------------------------
// Call expression generator – handles builtin + user function dispatch.
// Yields { kind:'instruction', name } after every hamster instruction,
// and { kind:'needsInput', message } when RunnerPause is caught.
// ---------------------------------------------------------------------------
function* evalCallExpressionGen(node, state, callDepth) {
    // ── Member call: receiver.method(args) ──────────────────────────────
    if (node.callee?.type === ASTNodeType.MemberExpression) {
        const methodName = node.callee.property;
        const args = [];
        for (const arg of node.arguments) {
            args.push(yield* evalExpressionGen(arg, state, callDepth));
        }

        if (node.callee.object?.type === ASTNodeType.SuperExpression) {
            const receiver = getVariable(state, 'this');
            const currentClass = currentClassName(state);
            const superClass = state.classes.get(currentClass)?.superClass;
            if (!superClass) {
                throw new Error('Class ' + currentClass + ' has no superclass method ' + methodName);
            }
            return yield* invokeInstanceMethodGen(
                receiver,
                methodName,
                args,
                state,
                callDepth,
                superClass,
                node.loc
            );
        }

        const receiver = yield* evalExpressionGen(node.callee.object, state, callDepth);

        // Compatibility: static class calls → user functions
        if (receiver && receiver.__kind === 'class') {
            const fn = findMethod(state, receiver.name, methodName, args.length, true);
            if (fn) {
                yield* initializeClassGen(state, fn.owner, callDepth, node.loc);
                yield { kind: 'call', name: fn.name, loc: node.loc || null };
                return yield* invokeUserFunctionGen(fn, args, state, callDepth + 1, null, fn.owner);
            }
        }

        if (receiver && typeof receiver === 'object' && receiver.__className &&
            state.classes.has(receiver.__className)) {
            const fn = findMethod(state, receiver.__className, methodName, args.length, false);
            if (fn) {
                yield { kind: 'call', name: fn.name, loc: node.loc || null };
                return yield* invokeUserFunctionGen(
                    fn,
                    args,
                    state,
                    callDepth + 1,
                    receiver,
                    fn.owner
                );
            }
        }

        if (receiver?.__kind === 'exception' ||
            (receiver?.__className && exceptionMatchesType(receiver, 'Throwable', state))) {
            return invokeExceptionMethod(receiver, methodName, args);
        }

        // Stop before executing a hamster instruction so the debugger can
        // highlight the line that is *about to* run.
        if (isHamsterInstruction(methodName)) {
            yield { kind: 'instruction', name: methodName, loc: node.loc || null };
        }

        // Runtime method call (retry loop for terminal input)
        let result;
        while (true) {
            try {
                if (typeof state.runtime.callMethod === 'function') {
                    result = state.runtime.callMethod(receiver, methodName, args, state.functions);
                } else {
                    const fallbackName = stringifyReceiver(receiver) + '.' + methodName;
                    result = state.runtime.callBuiltin(fallbackName, args, state.functions);
                }
                break;
            } catch (e) {
                if (e instanceof RunnerPause) {
                    yield { kind: 'needsInput', message: e.message };
                    continue;
                }
                throw normalizeBuiltinFailure(e);
            }
        }
        return result;
    }

    // ── Non-member call: func(args) ─────────────────────────────────────
    const args = [];
    for (const arg of node.arguments) {
        args.push(yield* evalExpressionGen(arg, state, callDepth));
    }
    const calleeName = resolveCalleeName(node.callee);
    if (!calleeName) {
        throw new Error('Unsupported call expression callee');
    }

    const receiver = tryGetVariable(state, 'this');
    const activeClass = receiver?.__className || currentClassName(state);
    if (activeClass) {
        const method = findMethod(state, activeClass, calleeName, args.length, receiver == null);
        if (method) {
            yield { kind: 'call', name: method.name, loc: node.loc || null };
            return yield* invokeUserFunctionGen(
                method,
                args,
                state,
                callDepth + 1,
                receiver,
                method.owner
            );
        }
        if (receiver && classHasNativeHamsterBase(state, activeClass) &&
            (isKnownBuiltinName(calleeName) || isHamsterInstruction(calleeName))) {
            return yield* invokeInstanceMethodGen(
                receiver, calleeName, args, state, callDepth, activeClass, node.loc
            );
        }
    }

    // User-defined function takes priority
    const candidates = (state.functions.get(calleeName) || []).filter(
        candidate => candidate.body && !candidate.owner
    );
    const fn = candidates.find(c => (c.parameters || []).length === args.length);
    if (fn) {
        // Stop on the call site so the debugger highlights the
        // function-call line before stepping into the function.
        yield { kind: 'call', name: fn.name, loc: node.loc || null };
        return yield* invokeUserFunctionGen(fn, args, state, callDepth + 1);
    }

    if (candidates.length > 0) {
        if (isKnownBuiltinName(calleeName)) {
            // Fall through to builtin
        } else {
            const expected = (candidates[0].parameters || []).length;
            throw new Error('Function ' + calleeName + ' expects ' + expected + ' arguments but got ' + args.length);
        }
    }

    // Stop before executing a hamster instruction so the debugger can
    // highlight the line that is *about to* run.
    if (isHamsterInstruction(calleeName)) {
        yield { kind: 'instruction', name: calleeName, loc: node.loc || null };
    }

    // Builtin call (retry loop for terminal input)
    let result;
    while (true) {
        try {
            result = state.runtime.callBuiltin(calleeName, args, state.functions);
            break;
        } catch (e) {
            if (e instanceof RunnerPause) {
                yield { kind: 'needsInput', message: e.message };
                continue;
            }
            throw normalizeBuiltinFailure(e);
        }
    }
    return result;
}

// ---------------------------------------------------------------------------
// User function invocation – transparent; each internal hamster instruction
// produces its own yield (matching mode A1/B compound-step behaviour).
// ---------------------------------------------------------------------------
function* invokeUserFunctionGen(fn, args, state, callDepth, receiver = null, className = null) {
    if (callDepth > 256) {
        throw new Error('Maximum function call depth exceeded');
    }
    if ((fn.parameters || []).length !== args.length) {
        throw new Error('Function ' + fn.name + ' expects ' + fn.parameters.length + ' arguments but got ' + args.length);
    }

    const functionScope = new Map();
    for (let i = 0; i < fn.parameters.length; i++) {
        functionScope.set(fn.parameters[i].name, args[i]);
    }
    if (receiver != null) {
        functionScope.set('this', receiver);
    }

    state.frames.push({
        name: fn.name,
        loc: fn.loc || null,
        scopeIndex: state.scopes.length,
        callerLoc: (state.lastInstruction && state.lastInstruction.loc) || null,
        className: className || fn.owner || null,
    });
    state.scopes.push(functionScope);
    try {
        if (!fn.body) {
            throw new Error('Cannot invoke abstract method ' + fn.name);
        }
        const result = yield* executeStatementGen(fn.body, state, callDepth);
        if (result instanceof ReturnSignal) {
            return fn.returnType === 'void' ? undefined : result.value;
        }
        return fn.returnType === 'void' ? undefined : defaultValueForType(fn.returnType);
    } finally {
        state.scopes.pop();
        state.frames.pop();
    }
}

// ---------------------------------------------------------------------------
// Binary expression generator
// ---------------------------------------------------------------------------
function* evalBinaryExpressionGen(node, state, callDepth) {
    const op = node.operator;
    if (op === '&&') {
        const left = truthy(yield* evalExpressionGen(node.left, state, callDepth));
        if (!left) return false;
        return truthy(yield* evalExpressionGen(node.right, state, callDepth));
    }
    if (op === '||') {
        const left = truthy(yield* evalExpressionGen(node.left, state, callDepth));
        if (left) return true;
        return truthy(yield* evalExpressionGen(node.right, state, callDepth));
    }

    const left = yield* evalExpressionGen(node.left, state, callDepth);
    const right = yield* evalExpressionGen(node.right, state, callDepth);

    switch (op) {
        case '+':
            if (typeof left === 'string' || typeof right === 'string') {
                return String(left) + String(right);
            }
            return Number(left) + Number(right);
        case '-': return Number(left) - Number(right);
        case '*': return Number(left) * Number(right);
        case '/': return Math.trunc(Number(left) / Number(right));
        case '%': return Number(left) % Number(right);
        case '==': return left === right;
        case '!=': return left !== right;
        case '<': return Number(left) < Number(right);
        case '<=': return Number(left) <= Number(right);
        case '>': return Number(left) > Number(right);
        case '>=': return Number(left) >= Number(right);
        default:
            throw new Error('Unsupported binary operator: ' + op);
    }
}

// ---------------------------------------------------------------------------
// Member / index / new expression generators
// ---------------------------------------------------------------------------
function* evalMemberExpressionGen(node, state, callDepth) {
    if (node.object?.type === ASTNodeType.SuperExpression) {
        const receiver = getVariable(state, 'this');
        const superClass = state.classes.get(currentClassName(state))?.superClass;
        return readMemberValue(state, receiver, node.property, superClass);
    }
    const receiver = yield* evalExpressionGen(node.object, state, callDepth);
    const lexicalClass = node.object?.type === ASTNodeType.ThisExpression
        ? currentClassName(state)
        : null;
    if (receiver?.__kind === 'class') {
        const owner = findStaticFieldOwner(state, receiver.name, node.property);
        if (owner) yield* initializeClassGen(state, owner, callDepth, node.loc);
    }
    return readMemberValue(state, receiver, node.property, lexicalClass);
}

function readMemberValue(state, receiver, property, startClass = null) {
    if (receiver == null) {
        throw new Error('Cannot read property ' + property + ' of null');
    }
    if (Array.isArray(receiver) && property === 'length') {
        return receiver.length;
    }
    if (receiver.__kind === 'class') {
        const owner = findStaticFieldOwner(state, receiver.name, property);
        if (owner) {
            return state.staticFields.get(owner).get(property);
        }
    }
    const fieldOwner = findInstanceFieldOwner(
        state,
        startClass || receiver.__className,
        property
    );
    if (fieldOwner && receiver.__fieldScopes?.[fieldOwner]) {
        return receiver.__fieldScopes[fieldOwner][property];
    }
    if (receiver.fields && Object.prototype.hasOwnProperty.call(receiver.fields, property)) {
        return receiver.fields[property];
    }
    if (typeof state.runtime.getMember === 'function') {
        const resolved = state.runtime.getMember(receiver, property, state.functions);
        if (resolved !== undefined) {
            return resolved;
        }
    }
    if (typeof receiver === 'object' && Object.prototype.hasOwnProperty.call(receiver, property)) {
        return receiver[property];
    }
    throw new Error('Unknown member: ' + property);
}

function* evalIndexExpressionGen(node, state, callDepth) {
    const target = yield* evalExpressionGen(node.object, state, callDepth);
    const index = Number(yield* evalExpressionGen(node.index, state, callDepth));
    return readIndexValue(target, index);
}

function readIndexValue(target, index) {
    if (Array.isArray(target)) {
        return target[index];
    }
    if (typeof target === 'string') {
        return target.charAt(index);
    }
    throw new Error('Index access is only supported for arrays and strings');
}

function* evalNewExpressionGen(node, state, callDepth) {
    if (node.dimensions && node.dimensions.length > 0) {
        return yield* evalArrayCreationGen(node, state, callDepth);
    }

    const args = [];
    for (const arg of (node.arguments || [])) {
        args.push(yield* evalExpressionGen(arg, state, callDepth));
    }
    const className = resolveCalleeName(node.callee) || 'Object';
    if (state.classes.has(className)) {
        yield* initializeClassGen(state, className, callDepth, node.loc);
        return yield* instantiateClassGen(className, args, state, callDepth, node.loc);
    }
    if (BUILTIN_EXCEPTION_SUPERTYPES.has(className)) {
        return createExceptionValue(className, args);
    }
    if (typeof state.runtime.createObject === 'function') {
        // Hamster constructor is a breakpoint (CreateInstruction).
        // Yield BEFORE constructing so the debugger highlights the line
        // that is *about to* run.
        if (className.endsWith('Hamster') && args.length >= 4) {
            yield { kind: 'instruction', name: 'createHamster', loc: node.loc || null };
        }
        const obj = state.runtime.createObject(className, args, state.functions);
        return obj;
    }
    return {
        __className: className,
        __args: args,
        fields: Object.create(null),
    };
}

/**
 * `new T[a][b][]` allocates nested arrays for every sized dimension. Leaves
 * get T's Java default (0/false/null), except when trailing dimensions are
 * left unsized: then the innermost sized level holds null sub-array slots.
 */
function* evalArrayCreationGen(node, state, callDepth) {
    const lengths = [];
    for (const dimension of node.dimensions) {
        if (dimension == null) break;
        lengths.push(toArrayLength(yield* evalExpressionGen(dimension, state, callDepth)));
    }
    if (lengths.length === 0) return [];
    const hasUnsizedDimensions = lengths.length < node.dimensions.length;
    const leafValue = hasUnsizedDimensions ? null : defaultValueForType(resolveCalleeName(node.callee));
    return createNestedArray(lengths, leafValue);
}

function toArrayLength(value) {
    const length = Number(value);
    return Number.isFinite(length) && length > 0 ? Math.trunc(length) : 0;
}

function createNestedArray(lengths, leafValue) {
    const [length, ...innerLengths] = lengths;
    if (innerLengths.length === 0) {
        return new Array(length).fill(leafValue);
    }
    return Array.from({ length }, () => createNestedArray(innerLengths, leafValue));
}

function castValue(value, node, state) {
    if (node.arrayDimensions > 0 || value == null) return value;
    if (node.targetType === 'int') return toJavaInt(value);
    if (node.targetType === 'boolean') return value;
    const targetType = simpleTypeName(node.targetType);
    const valueType = runtimeTypeName(value);
    if (valueType && isKnownReferenceType(state, targetType) &&
        !isAssignableToType(state, valueType, targetType)) {
        throw new HamsterLanguageException(createExceptionValue(
            'ClassCastException',
            [valueType + ' cannot be cast to ' + targetType]
        ));
    }
    return value;
}

/** Java's narrowing double→int conversion: truncate toward zero, NaN→0, saturate at the int range. */
function toJavaInt(value) {
    const number = Number(value);
    if (Number.isNaN(number)) return 0;
    return Math.trunc(Math.min(JAVA_INT_MAX, Math.max(JAVA_INT_MIN, number)));
}

function simpleTypeName(typeName) {
    return typeName.slice(typeName.lastIndexOf('.') + 1);
}

/** Type name of a runner/runtime object value, or null for primitives, arrays, and class references. */
function runtimeTypeName(value) {
    if (typeof value !== 'object' || Array.isArray(value)) return null;
    if (typeof value.__className === 'string') return value.__className;
    if (value.__kind === 'hamster') return value.className || 'Hamster';
    return null;
}

/**
 * Only types whose hierarchy the runner fully knows are checked; casts to
 * anything else (e.g. `Integer`, library types) pass through unchanged
 * rather than failing on a hierarchy we can't see.
 */
function isKnownReferenceType(state, typeName) {
    return state.classes.has(typeName) ||
        BUILTIN_EXCEPTION_SUPERTYPES.has(typeName) ||
        typeName === NATIVE_HAMSTER_CLASS;
}

function isAssignableToType(state, typeName, targetType) {
    const pending = [typeName];
    const visited = new Set();
    while (pending.length > 0) {
        const current = pending.pop();
        if (current === targetType || targetType === 'Object') return true;
        if (visited.has(current)) continue;
        visited.add(current);
        pending.push(...directSupertypes(state, current));
    }
    return false;
}

function directSupertypes(state, typeName) {
    const declaration = state.classes.get(typeName);
    if (declaration) {
        const interfaces = (declaration.interfaces || []).map(simpleTypeName);
        return declaration.superClass
            ? [simpleTypeName(declaration.superClass), ...interfaces]
            : interfaces;
    }
    if (BUILTIN_EXCEPTION_SUPERTYPES.has(typeName)) {
        return [BUILTIN_EXCEPTION_SUPERTYPES.get(typeName)];
    }
    // The runtime creates native objects for any `*Hamster` class name it doesn't know.
    if (typeName !== NATIVE_HAMSTER_CLASS && typeName.endsWith(NATIVE_HAMSTER_CLASS)) {
        return [NATIVE_HAMSTER_CLASS];
    }
    return [];
}

function* instantiateClassGen(className, args, state, callDepth, loc) {
    const declaration = state.classes.get(className);
    if (!declaration || declaration.type !== ASTNodeType.ClassDecl) {
        throw new Error('Cannot instantiate unknown or non-class type ' + className);
    }
    if ((declaration.modifiers || []).includes('abstract')) {
        throw new Error('Cannot instantiate abstract class ' + className);
    }
    const receiver = {
        __kind: 'object',
        __className: className,
        fields: Object.create(null),
        __fieldScopes: Object.create(null),
    };
    const constructor = (declaration.constructors || []).find(
        candidate => (candidate.parameters || []).length === args.length
    );
    if (!constructor && ((declaration.constructors || []).length > 0 || args.length > 0)) {
        throw new Error('No matching constructor for ' + className + '(' + args.length + ' arguments)');
    }
    yield* invokeConstructorGen(declaration, constructor, args, receiver, state, callDepth + 1, loc);
    return receiver;
}

function* invokeConstructorGen(declaration, constructor, args, receiver, state, callDepth, loc) {
    if (callDepth > 256) {
        throw new Error('Maximum constructor call depth exceeded');
    }
    const constructorScope = new Map([['this', receiver]]);
    if (constructor) {
        for (let i = 0; i < constructor.parameters.length; i++) {
            constructorScope.set(constructor.parameters[i].name, args[i]);
        }
    }
    state.frames.push({
        name: declaration.name,
        loc: constructor?.loc || declaration.loc || null,
        scopeIndex: state.scopes.length,
        callerLoc: loc || null,
        className: declaration.name,
    });
    state.scopes.push(constructorScope);
    try {
        const statements = constructor?.body?.statements || [];
        const chainingCall = getConstructorChainingCall(statements[0]);
        if (chainingCall?.kind === 'this') {
            const chainedArgs = [];
            for (const argument of chainingCall.arguments) {
                chainedArgs.push(yield* evalExpressionGen(argument, state, callDepth));
            }
            const target = (declaration.constructors || []).find(
                candidate => candidate !== constructor &&
                    (candidate.parameters || []).length === chainedArgs.length
            );
            if (!target) {
                throw new Error('No matching constructor for this(...) in ' + declaration.name);
            }
            yield* invokeConstructorGen(
                declaration, target, chainedArgs, receiver, state, callDepth + 1, chainingCall.loc
            );
        } else {
            const superArgs = [];
            if (chainingCall?.kind === 'super') {
                for (const argument of chainingCall.arguments) {
                    superArgs.push(yield* evalExpressionGen(argument, state, callDepth));
                }
            }
            yield* initializeSuperclassGen(
                declaration, superArgs, receiver, state, callDepth + 1, chainingCall?.loc || loc
            );
            const declaredFields = Object.create(null);
            receiver.__fieldScopes[declaration.name] = declaredFields;
            const instanceInitializers = [
                ...(declaration.fields || [])
                    .filter(field => !(field.modifiers || []).includes('static'))
                    .map(field => ({ kind: 'field', order: field.order, field })),
                ...(declaration.initializerBlocks || [])
                    .filter(initializer => !initializer.isStatic)
                    .map(initializer => ({
                        kind: 'block',
                        order: initializer.order,
                        body: initializer.body,
                    })),
            ].sort((left, right) => left.order - right.order);
            for (const initializer of instanceInitializers) {
                if (initializer.kind === 'field') {
                    const field = initializer.field;
                    const value = field.initializer
                        ? yield* evalExpressionGen(field.initializer, state, callDepth)
                        : defaultValueForType(field.varType);
                    declaredFields[field.name] = value;
                    receiver.fields[field.name] = value;
                } else {
                    const result = yield* executeStatementGen(
                        initializer.body,
                        state,
                        callDepth
                    );
                    if (result instanceof ReturnSignal) {
                        throw new Error('Instance initializer blocks cannot return');
                    }
                }
            }
        }
        for (let i = chainingCall ? 1 : 0; i < statements.length; i++) {
            const result = yield* executeStatementGen(statements[i], state, callDepth);
            if (result instanceof ReturnSignal) {
                if (result.value !== undefined) {
                    throw new Error('Constructors cannot return a value');
                }
                return;
            }
        }
    } finally {
        state.scopes.pop();
        state.frames.pop();
    }
}

function* initializeSuperclassGen(declaration, args, receiver, state, callDepth, loc) {
    if (!declaration.superClass || declaration.superClass === 'Object') {
        return;
    }
    const superDeclaration = state.classes.get(declaration.superClass);
    if (superDeclaration) {
        const constructor = (superDeclaration.constructors || []).find(
            candidate => (candidate.parameters || []).length === args.length
        );
        if (!constructor && (superDeclaration.constructors || []).length > 0) {
            throw new Error('No matching superclass constructor for ' + declaration.superClass);
        }
        yield* invokeConstructorGen(
            superDeclaration, constructor, args, receiver, state, callDepth + 1, loc
        );
        return;
    }
    if (BUILTIN_EXCEPTION_SUPERTYPES.has(declaration.superClass)) {
        const exception = createExceptionValue(declaration.superClass, args);
        receiver.message = exception.message;
        receiver.cause = exception.cause;
        return;
    }
    if (typeof state.runtime.createObject !== 'function') {
        throw new Error('Unknown superclass ' + declaration.superClass);
    }
    if (declaration.superClass.endsWith('Hamster') && args.length >= 4) {
        yield { kind: 'instruction', name: 'createHamster', loc: loc || declaration.loc || null };
    }
    const nativeObject = state.runtime.createObject(declaration.superClass, args, state.functions);
    Object.assign(receiver, nativeObject, {
        __className: receiver.__className,
        fields: receiver.fields,
    });
}

function getConstructorChainingCall(statement) {
    const call = statement?.type === ASTNodeType.ExpressionStmt ? statement.expression : null;
    if (call?.type !== ASTNodeType.CallExpression) {
        return null;
    }
    if (call.callee?.type === ASTNodeType.SuperExpression) {
        return { kind: 'super', arguments: call.arguments || [], loc: call.loc };
    }
    if (call.callee?.type === ASTNodeType.ThisExpression) {
        return { kind: 'this', arguments: call.arguments || [], loc: call.loc };
    }
    return null;
}

// ---------------------------------------------------------------------------
// Assignment target generator
// ---------------------------------------------------------------------------
function* assignTargetGen(state, targetNode, name, value, callDepth) {
    const reference = yield* resolveAssignmentTargetGen(state, targetNode, name, callDepth);
    reference.set(value);
}

function applyAssignmentOperator(operator, current, right) {
    if (operator === '=') return right;
    if (operator === '+=') {
        if (typeof current === 'string' || typeof right === 'string') {
            return String(current) + String(right);
        }
        return Number(current) + Number(right);
    }
    if (operator === '-=') return Number(current) - Number(right);
    throw new Error('Unsupported assignment operator: ' + operator);
}

function* resolveAssignmentTargetGen(state, targetNode, name, callDepth) {
    if (targetNode && targetNode.type === ASTNodeType.Identifier) {
        const receiver = tryGetVariable(state, 'this');
        const isLocal = hasLocalVariable(state, targetNode.name);
        const fieldOwner = !isLocal && receiver
            ? findInstanceFieldOwner(state, currentClassName(state), targetNode.name)
            : null;
        const staticOwner = !isLocal && !fieldOwner
            ? findStaticFieldOwner(state, currentClassName(state), targetNode.name)
            : null;
        return {
            get: () => fieldOwner
                ? receiver.__fieldScopes[fieldOwner][targetNode.name]
                : staticOwner
                    ? state.staticFields.get(staticOwner).get(targetNode.name)
                    : getVariable(state, targetNode.name),
            set: value => {
                if (fieldOwner) {
                    receiver.__fieldScopes[fieldOwner][targetNode.name] = value;
                    receiver.fields[targetNode.name] = value;
                } else if (staticOwner) {
                    state.staticFields.get(staticOwner).set(targetNode.name, value);
                } else {
                    assignVariable(state, targetNode.name, value);
                }
            },
        };
    }
    if (!targetNode && name) {
        return {
            get: () => getVariable(state, name),
            set: value => assignVariable(state, name, value),
        };
    }
    if (targetNode && targetNode.type === ASTNodeType.MemberExpression) {
        let receiver;
        let fieldStartClass = null;
        if (targetNode.object?.type === ASTNodeType.SuperExpression) {
            receiver = getVariable(state, 'this');
            fieldStartClass = state.classes.get(currentClassName(state))?.superClass;
        } else {
            receiver = yield* evalExpressionGen(targetNode.object, state, callDepth);
            if (targetNode.object?.type === ASTNodeType.ThisExpression) {
                fieldStartClass = currentClassName(state);
            }
        }
        if (receiver == null) {
            throw new Error('Cannot assign member on null receiver');
        }
        if (receiver.__kind === 'class') {
            const staticOwner = findStaticFieldOwner(state, receiver.name, targetNode.property);
            if (staticOwner) {
                yield* initializeClassGen(state, staticOwner, callDepth, targetNode.loc);
            }
        }
        return {
            get: () => readMemberValue(
                state,
                receiver,
                targetNode.property,
                fieldStartClass
            ),
            set: value => {
                if (receiver.__kind === 'class') {
                    const owner = findStaticFieldOwner(state, receiver.name, targetNode.property);
                    if (owner) {
                        state.staticFields.get(owner).set(targetNode.property, value);
                        return;
                    }
                }
                const fieldOwner = findInstanceFieldOwner(
                    state,
                    fieldStartClass || receiver.__className,
                    targetNode.property
                );
                if (fieldOwner && receiver.__fieldScopes?.[fieldOwner]) {
                    receiver.__fieldScopes[fieldOwner][targetNode.property] = value;
                    receiver.fields[targetNode.property] = value;
                    return;
                }
                if (receiver.fields &&
                    Object.prototype.hasOwnProperty.call(receiver.fields, targetNode.property)) {
                    receiver.fields[targetNode.property] = value;
                    return;
                }
                if (typeof state.runtime.setMember === 'function') {
                    const handled = state.runtime.setMember(receiver, targetNode.property, value, state.functions);
                    if (handled === true) {
                        return;
                    }
                }
                if (typeof receiver === 'object') {
                    receiver[targetNode.property] = value;
                    return;
                }
                throw new Error('Unsupported assignment target');
            },
        };
    }
    if (targetNode && targetNode.type === ASTNodeType.IndexExpression) {
        const receiver = yield* evalExpressionGen(targetNode.object, state, callDepth);
        const index = Number(yield* evalExpressionGen(targetNode.index, state, callDepth));
        return {
            get: () => readIndexValue(receiver, index),
            set: value => {
                if (Array.isArray(receiver)) {
                    receiver[index] = value;
                    return;
                }
                throw new Error('Unsupported index assignment target');
            },
        };
    }
    throw new Error('Unsupported assignment target');
}

// ---------------------------------------------------------------------------
// Helpers (unchanged)
// ---------------------------------------------------------------------------
function truthy(value) {
    return !!value;
}

function isControlSignal(value) {
    return value instanceof ReturnSignal || value instanceof BreakSignal;
}

function javaEquals(left, right) {
    return left === right;
}

function createExceptionValue(typeName, args = [], cause = null) {
    const message = args.length > 0 ? String(args[0]) : '';
    return {
        __kind: 'exception',
        __className: typeName,
        message,
        cause,
        toString() {
            return typeName + (message ? ': ' + message : '');
        },
    };
}

function invokeExceptionMethod(exception, methodName, args) {
    if (args.length > 0) {
        throw new Error(methodName + ' expects 0 arguments but got ' + args.length);
    }
    const message = exception.fields &&
        Object.prototype.hasOwnProperty.call(exception.fields, 'message')
        ? exception.fields.message
        : exception.message || '';
    const cause = exception.fields &&
        Object.prototype.hasOwnProperty.call(exception.fields, 'cause')
        ? exception.fields.cause
        : exception.cause || null;
    if (methodName === 'getMessage' || methodName === 'getNachricht') {
        return message;
    }
    if (methodName === 'getCause') {
        return cause;
    }
    if (methodName === 'toString') {
        const typeName = exception.__className || 'HamsterException';
        return typeName + (message ? ': ' + message : '');
    }
    throw new Error('Unknown exception method: ' + methodName);
}

function exceptionTypeName(value) {
    if (value && typeof value === 'object' && value.__className) {
        return value.__className;
    }
    if (value === null) return 'null';
    if (typeof value === 'number') return 'int';
    if (typeof value === 'boolean') return 'boolean';
    if (typeof value === 'string') return 'String';
    return 'Throwable';
}

function exceptionMatchesType(value, catchType, state) {
    let currentType = exceptionTypeName(value);
    if (catchType === 'Object') return true;
    const visited = new Set();
    while (currentType && !visited.has(currentType)) {
        if (currentType === catchType) return true;
        visited.add(currentType);
        currentType = state.classes.get(currentType)?.superClass ||
            BUILTIN_EXCEPTION_SUPERTYPES.get(currentType) ||
            null;
    }
    return false;
}

function normalizeBuiltinFailure(error) {
    if (error instanceof RunnerPause || error instanceof HamsterLanguageException) {
        return error;
    }
    const message = error instanceof Error ? error.message : String(error);
    const typeName = error?.hamsterExceptionType;
    if (!typeName) return error;
    return new HamsterLanguageException(createExceptionValue(typeName, [message], error));
}

function defaultValueForType(typeName) {
    if (typeName === 'boolean') return false;
    if (typeName === 'int') return 0;
    return null;
}

function declareVariable(state, name, value) {
    const scope = state.scopes[state.scopes.length - 1];
    if (scope.has(name)) {
        throw new Error('Variable already declared: ' + name);
    }
    scope.set(name, value);
}

function assignVariable(state, name, value) {
    for (const i of visibleScopeIndices(state)) {
        const scope = state.scopes[i];
        if (scope.has(name)) {
            scope.set(name, value);
            return;
        }
    }
    throw new Error('Unknown variable: ' + name);
}

function getVariable(state, name) {
    for (const i of visibleScopeIndices(state)) {
        const scope = state.scopes[i];
        if (scope.has(name)) {
            return scope.get(name);
        }
    }
    throw new Error('Unknown variable: ' + name);
}

function tryGetVariable(state, name) {
    for (const i of visibleScopeIndices(state)) {
        if (state.scopes[i].has(name)) {
            return state.scopes[i].get(name);
        }
    }
    return undefined;
}

function hasLocalVariable(state, name) {
    return localScopeIndices(state).some(index => state.scopes[index].has(name));
}

function localScopeIndices(state) {
    return visibleScopeIndices(state).filter(index => index !== 0);
}

function visibleScopeIndices(state) {
    const frame = state.frames[state.frames.length - 1];
    const firstLocalScope = frame?.scopeIndex ?? 1;
    const indices = [];
    for (let i = state.scopes.length - 1; i >= firstLocalScope; i--) {
        indices.push(i);
    }
    if (state.scopes.length > 0 && !indices.includes(0)) {
        indices.push(0);
    }
    return indices;
}

function resolveIdentifierValue(state, name) {
    for (const index of localScopeIndices(state)) {
        if (state.scopes[index].has(name)) {
            return state.scopes[index].get(name);
        }
    }
    const receiver = tryGetVariable(state, 'this');
    const fieldOwner = receiver
        ? findInstanceFieldOwner(state, currentClassName(state), name)
        : null;
    if (fieldOwner && receiver.__fieldScopes?.[fieldOwner]) {
        return receiver.__fieldScopes[fieldOwner][name];
    }
    const staticOwner = findStaticFieldOwner(state, currentClassName(state), name);
    if (staticOwner) {
        return state.staticFields.get(staticOwner).get(name);
    }
    if (state.scopes[0]?.has(name)) {
        return state.scopes[0].get(name);
    }
    if (state.classes.has(name)) {
        return { __kind: 'class', name };
    }
    if (typeof state.runtime.resolveIdentifier === 'function') {
        const resolved = state.runtime.resolveIdentifier(name, state.functions);
        if (resolved !== undefined) {
            return resolved;
        }
    }
    throw new Error('Unknown variable: ' + name);
}

function currentClassName(state) {
    return state.frames[state.frames.length - 1]?.className || null;
}

function flattenClassDeclarations(declarations) {
    const result = [];
    for (const declaration of declarations) {
        result.push(declaration);
        result.push(...flattenClassDeclarations(declaration.nestedClasses || []));
    }
    return result;
}

function selectMainFunction(candidates) {
    const runnable = candidates.filter(candidate =>
        candidate.body &&
        candidate.returnType === 'void' &&
        (candidate.parameters || []).length === 0
    );
    const topLevel = runnable.filter(candidate => !candidate.owner);
    if (topLevel.length > 1) {
        throw new Error('Program defines multiple top-level void main() functions');
    }
    if (topLevel.length === 1) {
        return topLevel[0];
    }
    const staticMethods = runnable.filter(candidate =>
        (candidate.modifiers || []).includes('static')
    );
    if (staticMethods.length > 1) {
        throw new Error('Program defines multiple static void main() methods');
    }
    if (staticMethods.length === 1) {
        return staticMethods[0];
    }
    const instanceMethods = runnable.filter(candidate => candidate.owner);
    if (instanceMethods.length > 1) {
        throw new Error('Program defines multiple instance void main() methods');
    }
    if (instanceMethods.length === 1) {
        return instanceMethods[0];
    }
    throw new Error('Program must define void main()');
}

function findMethod(state, className, methodName, argumentCount, requireStatic) {
    let current = className;
    const visited = new Set();
    while (current && !visited.has(current)) {
        visited.add(current);
        const declaration = state.classes.get(current);
        if (!declaration) {
            return null;
        }

        const method = (declaration.methods || []).find(candidate => {
            const isStatic = (candidate.modifiers || []).includes('static');
            return candidate.name === methodName &&
                (candidate.parameters || []).length === argumentCount &&
                (!requireStatic || isStatic);
        });
        if (method) {
            return method;
        }
        current = declaration.superClass;
    }
    return null;
}

function findStaticFieldOwner(state, className, fieldName) {
    let current = className;
    const visited = new Set();
    while (current && !visited.has(current)) {
        visited.add(current);
        if (state.staticFields.get(current)?.has(fieldName)) {
            return current;
        }
        current = state.classes.get(current)?.superClass;
    }
    return null;
}

function findInstanceFieldOwner(state, className, fieldName) {
    let current = className;
    const visited = new Set();
    while (current && !visited.has(current)) {
        visited.add(current);
        const declaration = state.classes.get(current);
        if ((declaration?.fields || []).some(field =>
            field.name === fieldName && !(field.modifiers || []).includes('static'))) {
            return current;
        }
        current = declaration?.superClass;
    }
    return null;
}

function classHasNativeHamsterBase(state, className) {
    let current = className;
    const visited = new Set();
    while (current && !visited.has(current)) {
        visited.add(current);
        if (current.endsWith('Hamster') && !state.classes.has(current)) {
            return true;
        }
        current = state.classes.get(current)?.superClass;
    }
    return false;
}

function* invokeInstanceMethodGen(receiver, methodName, args, state, callDepth, startClass, loc) {
    const method = findMethod(state, startClass, methodName, args.length, false);
    if (method) {
        yield { kind: 'call', name: method.name, loc: loc || null };
        return yield* invokeUserFunctionGen(
            method, args, state, callDepth + 1, receiver, method.owner
        );
    }
    if (isHamsterInstruction(methodName)) {
        yield { kind: 'instruction', name: methodName, loc: loc || null };
    }
    if (typeof state.runtime.callMethod === 'function') {
        while (true) {
            try {
                return state.runtime.callMethod(receiver, methodName, args, state.functions);
            } catch (error) {
                if (error instanceof RunnerPause) {
                    yield { kind: 'needsInput', message: error.message };
                    continue;
                }
                throw normalizeBuiltinFailure(error);
            }
        }
    }
    throw new Error('Unknown method: ' + methodName);
}

function stringifyReceiver(receiver) {
    if (receiver && typeof receiver === 'object' && typeof receiver.__className === 'string') {
        return receiver.__className;
    }
    if (typeof receiver === 'string') {
        return receiver;
    }
    return 'object';
}

function resolveCalleeName(calleeNode) {
    if (!calleeNode) {
        return null;
    }
    if (typeof calleeNode === 'string') {
        return calleeNode;
    }
    if (calleeNode.type === ASTNodeType.Identifier) {
        return calleeNode.name;
    }
    if (calleeNode.type === ASTNodeType.MemberExpression) {
        const objectName = resolveCalleeName(calleeNode.object);
        if (!objectName) return null;
        return objectName + '.' + calleeNode.property;
    }
    return null;
}
