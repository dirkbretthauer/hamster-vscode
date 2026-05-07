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

// ---------------------------------------------------------------------------
// Hamster instructions that constitute breakpoints (mode A1/B).
// One step = one hamster instruction.  Everything else executes invisibly.
// ---------------------------------------------------------------------------
const HAMSTER_INSTRUCTIONS = new Set([
    'vor', 'linksUm', 'nimm', 'gib',
    'vornFrei', 'kornDa', 'maulLeer',
    'getReihe', 'getSpalte', 'getBlickrichtung',
    'getAnzahlKoerner', 'anzahlKoerner',
    'schreib',
    'readInt', 'readString',
    'liesZahl', 'liesZeichenkette', 'liesString',
    'createHamster',
    'rechtsUm',
]);

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
    'getReihe',
    'getSpalte',
    'getBlickrichtung',
    'getAnzahlKoerner',
    'anzahlKoerner',
    'createHamster',
    'readInt',
    'readString',
]);

function isKnownBuiltinName(name) {
    if (KNOWN_BUILTINS.has(name)) return true;
    if (name === 'Math.random') return true;
    if (name.endsWith('.getStandardHamster') || name.endsWith('.getStandardHamsterAlsDrehHamster')) return true;
    return false;
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API – createRunnerState / executeRunnerStep
// ═══════════════════════════════════════════════════════════════════════════

export function createRunnerState(ast, runtime) {
    const functions = new Map();
    for (const fn of ast.functions || []) {
        if (!functions.has(fn.name)) {
            functions.set(fn.name, []);
        }
        functions.get(fn.name).push(fn);
    }
    const mainCandidates = functions.get('main') || [];
    const main = mainCandidates.find(fn => (fn.parameters || []).length === 0) || null;
    if (!main) {
        throw new Error('Program must define void main()');
    }
    if (!runtime || typeof runtime.callBuiltin !== 'function') {
        throw new Error('Runner runtime must provide callBuiltin(name, args, functions)');
    }

    const state = {
        ast,
        functions,
        runtime,
        finished: false,
        scopes: [new Map()],
        // Legacy stack field kept for backward-compatible state inspection.
        stack: [],
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
 * Advance execution to the next hamster instruction (mode A1/B).
 *
 * Returns `true` if the program has more work, `false` when finished.
 * Throws `RunnerPause` when the program needs terminal input.
 */
export function executeRunnerStep(state) {
    if (state.finished || !state.generator) return false;

    const result = state.generator.next();
    if (result.done) {
        state.finished = true;
        return false;
    }

    const yielded = result.value;
    if (yielded && yielded.kind === 'needsInput') {
        throw new RunnerPause(yielded.message || 'Waiting for input');
    }

    // yielded.kind === 'instruction'  →  one hamster command completed = one visible step.
    // Expose the last instruction info (including loc) for debugger integration.
    state.lastInstruction = yielded || null;
    return true;
}

// ═══════════════════════════════════════════════════════════════════════════
// Generator-based interpreter (matches original mode A1/B)
//
// The generator yields a { kind, name } descriptor after every hamster
// instruction.  Non-hamster statements (variable decls, control flow,
// arithmetic, user-defined functions) execute transparently without yielding.
// ═══════════════════════════════════════════════════════════════════════════

function* programGenerator(state, mainFn) {
    try {
        yield* executeStatementGen(mainFn.body, state, 0);
    } finally {
        state.finished = true;
    }
}

// ---------------------------------------------------------------------------
// Statement generator – returns undefined or ReturnSignal
// ---------------------------------------------------------------------------
function* executeStatementGen(node, state, callDepth) {
    if (!node) return undefined;

    switch (node.type) {
        case ASTNodeType.Block: {
            state.scopes.push(new Map());
            try {
                for (const stmt of node.statements || []) {
                    const result = yield* executeStatementGen(stmt, state, callDepth);
                    if (result instanceof ReturnSignal) return result;
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
                if (result instanceof ReturnSignal) return result;
            }
            return undefined;
        }

        case ASTNodeType.DoWhileStatement: {
            let guard = 0;
            do {
                if (++guard > 100000) throw new Error('Loop iteration limit exceeded');
                const result = yield* executeStatementGen(node.body, state, callDepth);
                if (result instanceof ReturnSignal) return result;
            } while (truthy(yield* evalExpressionGen(node.test, state, callDepth)));
            return undefined;
        }

        case ASTNodeType.ForStatement:
            throw new Error('For statements are not supported at runtime');

        case ASTNodeType.VariableDecl: {
            let value = defaultValueForType(node.varType);
            if (node.initializer) {
                value = yield* evalExpressionGen(node.initializer, state, callDepth);
            }
            declareVariable(state, node.name, value);
            return undefined;
        }

        case ASTNodeType.Assignment: {
            const value = yield* evalExpressionGen(node.value, state, callDepth);
            yield* assignTargetGen(state, node.target ?? null, node.name, value, callDepth);
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

// ---------------------------------------------------------------------------
// Expression generator – returns the evaluated value.
// Yields only when a hamster instruction is encountered inside a call.
// ---------------------------------------------------------------------------
function* evalExpressionGen(node, state, callDepth) {
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

        case ASTNodeType.UnaryExpression: {
            const value = yield* evalExpressionGen(node.argument, state, callDepth);
            if (node.operator === '!') return !truthy(value);
            if (node.operator === '-') return -Number(value);
            throw new Error('Unsupported unary operator: ' + node.operator);
        }

        case ASTNodeType.PostfixExpression: {
            if ((node.operator !== '--' && node.operator !== '++') || node.argument.type !== ASTNodeType.Identifier) {
                throw new Error('Only identifier++/identifier-- is supported');
            }
            const current = Number(getVariable(state, node.argument.name));
            const delta = node.operator === '++' ? 1 : -1;
            assignVariable(state, node.argument.name, current + delta);
            return current;
        }

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
        const receiver = yield* evalExpressionGen(node.callee.object, state, callDepth);
        const methodName = node.callee.property;
        const args = [];
        for (const arg of node.arguments) {
            args.push(yield* evalExpressionGen(arg, state, callDepth));
        }

        // Compatibility: static class calls → user functions
        if (receiver && receiver.__kind === 'class') {
            const candidates = state.functions.get(methodName) || [];
            const fn = candidates.find(c => (c.parameters || []).length === args.length);
            if (fn) {
                return yield* invokeUserFunctionGen(fn, args, state, callDepth + 1);
            }
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
                throw e;
            }
        }

        if (isHamsterInstruction(methodName)) {
            yield { kind: 'instruction', name: methodName, loc: node.loc || null };
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

    // User-defined function takes priority
    const candidates = state.functions.get(calleeName) || [];
    const fn = candidates.find(c => (c.parameters || []).length === args.length);
    if (fn) {
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
            throw e;
        }
    }

    if (isHamsterInstruction(calleeName)) {
        yield { kind: 'instruction', name: calleeName, loc: node.loc || null };
    }
    return result;
}

// ---------------------------------------------------------------------------
// User function invocation – transparent; each internal hamster instruction
// produces its own yield (matching mode A1/B compound-step behaviour).
// ---------------------------------------------------------------------------
function* invokeUserFunctionGen(fn, args, state, callDepth) {
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

    state.scopes.push(functionScope);
    try {
        const result = yield* executeStatementGen(fn.body, state, callDepth);
        if (result instanceof ReturnSignal) {
            return fn.returnType === 'void' ? undefined : result.value;
        }
        return fn.returnType === 'void' ? undefined : defaultValueForType(fn.returnType);
    } finally {
        state.scopes.pop();
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
        case '+': return Number(left) + Number(right);
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
    const receiver = yield* evalExpressionGen(node.object, state, callDepth);
    if (receiver == null) {
        throw new Error('Cannot read property ' + node.property + ' of null');
    }
    if (Array.isArray(receiver) && node.property === 'length') {
        return receiver.length;
    }
    if (typeof state.runtime.getMember === 'function') {
        const resolved = state.runtime.getMember(receiver, node.property, state.functions);
        if (resolved !== undefined) {
            return resolved;
        }
    }
    if (typeof receiver === 'object' && Object.prototype.hasOwnProperty.call(receiver, node.property)) {
        return receiver[node.property];
    }
    throw new Error('Unknown member: ' + node.property);
}

function* evalIndexExpressionGen(node, state, callDepth) {
    const target = yield* evalExpressionGen(node.object, state, callDepth);
    const index = Number(yield* evalExpressionGen(node.index, state, callDepth));
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
        const firstDim = node.dimensions[0];
        const length = firstDim == null ? 0 : Number(yield* evalExpressionGen(firstDim, state, callDepth));
        const safeLength = Number.isFinite(length) && length > 0 ? Math.trunc(length) : 0;
        return new Array(safeLength).fill(null);
    }

    const args = [];
    for (const arg of (node.arguments || [])) {
        args.push(yield* evalExpressionGen(arg, state, callDepth));
    }
    if (typeof state.runtime.createObject === 'function') {
        const className = resolveCalleeName(node.callee) || 'Object';
        const obj = state.runtime.createObject(className, args, state.functions);
        // Hamster constructor is a breakpoint (CreateInstruction)
        if (className.endsWith('Hamster')) {
            yield { kind: 'instruction', name: 'createHamster', loc: node.loc || null };
        }
        return obj;
    }
    return {
        __className: resolveCalleeName(node.callee) || 'Object',
        __args: args,
    };
}

// ---------------------------------------------------------------------------
// Assignment target generator
// ---------------------------------------------------------------------------
function* assignTargetGen(state, targetNode, name, value, callDepth) {
    if (targetNode && targetNode.type === ASTNodeType.Identifier) {
        assignVariable(state, targetNode.name, value);
        return;
    }
    if (!targetNode && name) {
        assignVariable(state, name, value);
        return;
    }
    if (targetNode && targetNode.type === ASTNodeType.MemberExpression) {
        const receiver = yield* evalExpressionGen(targetNode.object, state, callDepth);
        if (receiver == null) {
            throw new Error('Cannot assign member on null receiver');
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
    }
    if (targetNode && targetNode.type === ASTNodeType.IndexExpression) {
        const receiver = yield* evalExpressionGen(targetNode.object, state, callDepth);
        const index = Number(yield* evalExpressionGen(targetNode.index, state, callDepth));
        if (Array.isArray(receiver)) {
            receiver[index] = value;
            return;
        }
        throw new Error('Unsupported index assignment target');
    }
    throw new Error('Unsupported assignment target');
}

// ---------------------------------------------------------------------------
// Helpers (unchanged)
// ---------------------------------------------------------------------------
function truthy(value) {
    return !!value;
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
    for (let i = state.scopes.length - 1; i >= 0; i--) {
        const scope = state.scopes[i];
        if (scope.has(name)) {
            scope.set(name, value);
            return;
        }
    }
    throw new Error('Unknown variable: ' + name);
}

function getVariable(state, name) {
    for (let i = state.scopes.length - 1; i >= 0; i--) {
        const scope = state.scopes[i];
        if (scope.has(name)) {
            return scope.get(name);
        }
    }
    throw new Error('Unknown variable: ' + name);
}

function resolveIdentifierValue(state, name) {
    try {
        return getVariable(state, name);
    } catch (error) {
        if (typeof state.runtime.resolveIdentifier === 'function') {
            const resolved = state.runtime.resolveIdentifier(name, state.functions);
            if (resolved !== undefined) {
                return resolved;
            }
        }
        throw error;
    }
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
