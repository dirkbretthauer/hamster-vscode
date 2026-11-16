import { HamsterParserError, ASTNodeType, parseProgram, collectProgramErrors } from './hamster-parser.js';

/**
 * First semantic pass. It deliberately only reports mistakes that are certain
 * (typos in names, wrong argument counts for user functions, clashing literal
 * types) because the Java library surface the simulator accepts is open-ended
 * and a false red squiggle is worse than a missing one.
 */

const HAMSTER_BUILTIN_CALLS = new Set([
    'vor', 'linksUm', 'rechtsUm', 'nimm', 'gib', 'vornFrei', 'kornDa', 'maulLeer',
    'move', 'turnLeft', 'pickGrain', 'putGrain', 'frontIsClear', 'grainAvailable', 'mouthEmpty',
    'getReihe', 'getSpalte', 'getBlickrichtung', 'getAnzahlKoerner', 'anzahlKoerner',
    'getRow', 'getColumn', 'getDirection', 'getNumberOfGrains', 'getColor', 'getFarbe',
    'createHamster', 'init', 'initialisiere',
    'schreib', 'write', 'liesZahl', 'liesZeichenkette', 'liesString',
    'readInt', 'readNumber', 'readString',
]);

const INHERITED_OBJECT_METHODS = new Set([
    'wait', 'notify', 'notifyAll', 'getClass', 'hashCode', 'equals', 'toString', 'clone',
]);
const IMPORT_OR_PACKAGE_PATTERN = /^\s*(?:import|package)\s/m;
const LENGTH_PSEUDO_FIELD = 'length';
const JAVA_PACKAGE_ROOTS = new Set(['java', 'javax']);

const COMPATIBLE_TYPES_BY_LITERAL = Object.freeze({
    boolean: new Set(['boolean', 'Boolean']),
    String: new Set(['String']),
    int: new Set(['int', 'long', 'short', 'byte', 'float', 'double', 'Integer', 'Long', 'Double', 'char']),
});
const CHECKED_TARGET_TYPES = new Set([
    'boolean', 'int', 'long', 'short', 'byte', 'float', 'double', 'char', 'String',
]);

function semanticError(message, node, length = 1) {
    const loc = node?.loc ?? { line: 1, column: 1 };
    return new HamsterParserError(message, { line: loc.line, column: loc.column, length });
}

function isNode(value) {
    return value !== null && typeof value === 'object' && typeof value.type === 'string';
}

function forEachChild(node, visit) {
    for (const [key, value] of Object.entries(node)) {
        if (key === 'loc') continue;
        if (Array.isArray(value)) {
            value.forEach(item => isNode(item) && visit(item));
        } else if (isNode(value)) {
            visit(value);
        }
    }
}

function walk(node, visit) {
    visit(node);
    forEachChild(node, child => walk(child, visit));
}

function flattenClasses(classes) {
    return (classes ?? []).flatMap(declaration => [
        declaration,
        ...flattenClasses(declaration.nestedClasses),
    ]);
}

function acceptsArgumentCount(fn, count) {
    const parameters = fn.parameters ?? [];
    const hasVarargs = parameters.some(parameter => parameter.isVarargs);
    return hasVarargs ? count >= parameters.length - 1 : count === parameters.length;
}

function collectDeclaredNames(root) {
    const names = new Set();
    walk(root, node => {
        switch (node.type) {
            case ASTNodeType.VariableDecl:
            case ASTNodeType.Parameter:
            case ASTNodeType.ForEachStatement:
                names.add(node.name);
                break;
            case ASTNodeType.CatchClause:
                names.add(node.paramName);
                break;
            default:
        }
    });
    return names;
}

// `new int[3]` and `foo()` carry a type/function name in an Identifier node, not a variable read.
function collectNameOnlyIdentifiers(root) {
    const nameOnly = new Set();
    walk(root, node => {
        const isNameHolder = node.type === ASTNodeType.CallExpression ||
            node.type === ASTNodeType.NewExpression;
        if (isNameHolder && node.callee) nameOnly.add(node.callee);
        // `reversi.Regeln.check()`: a lowercase root followed by a class name is a package path.
        const isPackageQualifier = node.type === ASTNodeType.MemberExpression &&
            node.object?.type === ASTNodeType.Identifier && looksLikeTypeName(node.property);
        if (isPackageQualifier) nameOnly.add(node.object);
    });
    return nameOnly;
}

function buildProgramContext(ast) {
    const classes = flattenClasses(ast.classes);
    const classNames = new Set(classes.map(declaration => declaration.name));
    const functionsByName = new Map();
    for (const fn of ast.functions ?? []) {
        if (!functionsByName.has(fn.name)) functionsByName.set(fn.name, []);
        functionsByName.get(fn.name).push(fn);
    }
    const sharedNames = new Set((ast.globals ?? []).map(declaration => declaration.name));
    for (const declaration of classes) {
        (declaration.fields ?? []).forEach(field => sharedNames.add(field.name));
        (declaration.enumConstants ?? []).forEach(constant => sharedNames.add(constant));
    }
    return { classes, classNames, functionsByName, sharedNames };
}

// Inherited members of a library superclass are invisible to this pass.
function hasForeignSuperclass(declaration, context) {
    const superClass = declaration?.superClass;
    return Boolean(superClass) && !context.classNames.has(superClass) && superClass !== 'Hamster';
}

function checkDuplicateClasses(context, errors) {
    const seen = new Set();
    for (const declaration of context.classes) {
        if (seen.has(declaration.name)) {
            errors.push(semanticError(
                `Duplicate class '${declaration.name}'`, declaration, declaration.name.length
            ));
        }
        seen.add(declaration.name);
    }
}

function checkCall(node, context, errors, ownerDeclaration) {
    const callee = node.callee;
    if (callee?.type !== ASTNodeType.Identifier) return;
    const name = callee.name;
    const candidates = context.functionsByName.get(name);
    const isBuiltin = HAMSTER_BUILTIN_CALLS.has(name) || INHERITED_OBJECT_METHODS.has(name);
    if (!candidates) {
        if (isBuiltin || !context.resolvesAllNames || hasForeignSuperclass(ownerDeclaration, context)) {
            return;
        }
        errors.push(semanticError(`Unknown function '${name}'`, callee, name.length));
        return;
    }
    if (isBuiltin || candidates.some(fn => acceptsArgumentCount(fn, node.arguments.length))) return;
    const expectedText = [...new Set(candidates.map(fn => fn.parameters.length))].join(' or ');
    errors.push(semanticError(
        `Function '${name}' expects ${expectedText} argument(s) but got ${node.arguments.length}`,
        callee,
        name.length
    ));
}

function looksLikeTypeName(name) {
    return /^[A-Z]/.test(name);
}

function checkIdentifier(node, declared, context, errors, ownerDeclaration) {
    const name = node.name;
    if (declared.has(name) || context.sharedNames.has(name) ||
        name === LENGTH_PSEUDO_FIELD || JAVA_PACKAGE_ROOTS.has(name)) return;
    if (looksLikeTypeName(name) || hasForeignSuperclass(ownerDeclaration, context)) return;
    errors.push(semanticError(`Unknown variable '${name}'`, node, name.length));
}

function literalKind(literal) {
    if (literal.literalType === 'boolean') return 'boolean';
    if (literal.literalType === 'int') return 'int';
    if (literal.literalType === 'string' || literal.literalType === 'String') return 'String';
    return null;
}

function checkDeclarationInitializer(node, errors) {
    const initializer = node.initializer;
    if (initializer?.type !== ASTNodeType.Literal || !CHECKED_TARGET_TYPES.has(node.varType)) {
        return;
    }
    const kind = literalKind(initializer);
    if (!kind || COMPATIBLE_TYPES_BY_LITERAL[kind].has(node.varType)) return;
    errors.push(semanticError(`Type mismatch: cannot convert ${kind} to ${node.varType}`, initializer));
}

function analyzeFunction(fn, context, errors, ownerDeclaration) {
    if (!fn.body) return;
    const checkNames = context.resolvesAllNames;
    const declared = collectDeclaredNames(fn);
    const nameOnly = collectNameOnlyIdentifiers(fn.body);
    walk(fn.body, node => {
        if (node.type === ASTNodeType.CallExpression) {
            checkCall(node, context, errors, ownerDeclaration);
        } else if (checkNames && node.type === ASTNodeType.Identifier && !nameOnly.has(node)) {
            checkIdentifier(node, declared, context, errors, ownerDeclaration);
        } else if (node.type === ASTNodeType.VariableDecl) {
            checkDeclarationInitializer(node, errors);
        }
    });
}

/**
 * @param {object} ast
 * @param {{ resolvesAllNames?: boolean }} options set to false when names may come
 *   from other files (packages/imports), which disables the unknown-name checks.
 */
export function collectSemanticErrors(ast, { resolvesAllNames = true } = {}) {
    const errors = [];
    const context = { ...buildProgramContext(ast), resolvesAllNames };
    checkDuplicateClasses(context, errors);
    const ownerByFunction = new Map();
    for (const declaration of context.classes) {
        [...(declaration.methods ?? []), ...(declaration.constructors ?? [])]
            .forEach(fn => ownerByFunction.set(fn, declaration));
    }
    const analyzed = new Set();
    const analyze = fn => {
        if (analyzed.has(fn)) return;
        analyzed.add(fn);
        analyzeFunction(fn, context, errors, ownerByFunction.get(fn));
    };
    (ast.functions ?? []).forEach(analyze);
    for (const declaration of context.classes) {
        [...(declaration.methods ?? []), ...(declaration.constructors ?? [])].forEach(analyze);
    }
    return errors;
}

/** Syntax errors first; the semantic pass only runs on a program that parsed cleanly. */
export function collectDiagnostics(source, options = {}) {
    const syntaxErrors = collectProgramErrors(source, options);
    if (syntaxErrors.length > 0) return syntaxErrors;
    const ast = parseProgram(source, { ...options, strict: true });
    return collectSemanticErrors(ast, {
        resolvesAllNames: !IMPORT_OR_PACKAGE_PATTERN.test(source),
    });
}
