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
    'getStandardHamster', 'getDefaultHamster', 'getAnzahlHamster', 'getNumberOfHamsters',
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

function flattenClasses(classes, enclosing = null, enclosingByClass = new Map()) {
    const result = [];
    for (const declaration of classes ?? []) {
        enclosingByClass.set(declaration, enclosing);
        const nested = flattenClasses(declaration.nestedClasses, declaration, enclosingByClass);
        result.push(declaration, ...nested.classes);
    }
    return { classes: result, enclosingByClass };
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

function packageQualifierRoot(memberExpression) {
    let hasClassSegment = false;
    let current = memberExpression;
    while (current?.type === ASTNodeType.MemberExpression) {
        hasClassSegment ||= looksLikeTypeName(current.property);
        current = current.object;
    }
    return hasClassSegment && current?.type === ASTNodeType.Identifier ? current : null;
}

// `new int[3]` and `foo()` carry a type/function name in an Identifier node, not a variable read.
function collectNameOnlyIdentifiers(root) {
    const nameOnly = new Set();
    walk(root, node => {
        const isNameHolder = node.type === ASTNodeType.CallExpression ||
            node.type === ASTNodeType.NewExpression;
        if (isNameHolder && node.callee) nameOnly.add(node.callee);
        // `reversi.Regeln.check()`, `de.hamster.Hamster`: a lowercase root followed by a path
        // containing a class name is a package path.
        if (node.type === ASTNodeType.MemberExpression) {
            const root = packageQualifierRoot(node);
            if (root) nameOnly.add(root);
        }
    });
    return nameOnly;
}

function buildProgramContext(ast) {
    const { classes, enclosingByClass } = flattenClasses(ast.classes);
    const classByName = new Map();
    for (const declaration of classes) {
        if (!classByName.has(declaration.name)) classByName.set(declaration.name, declaration);
    }
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
    return { classes, classNames, classByName, enclosingByClass, functionsByName, sharedNames };
}

function inheritsFromUnknownType(declaration, context) {
    const visited = new Set();
    let current = declaration;
    while (current && !visited.has(current)) {
        visited.add(current);
        if ((current.interfaces ?? []).some(name => !context.classNames.has(name))) return true;
        const superClass = current.superClass;
        if (!superClass || superClass === 'Hamster') return false;
        if (!context.classNames.has(superClass)) return true;
        current = context.classByName.get(superClass);
    }
    return false;
}

// Members inherited from library supertypes (directly, via a user class chain, or through an
// enclosing class) are invisible to this pass.
function mayInheritUnknownMembers(declaration, context) {
    for (let scope = declaration; scope; scope = context.enclosingByClass.get(scope)) {
        if (inheritsFromUnknownType(scope, context)) return true;
    }
    return false;
}

// The node location is the class keyword, not the name, so the keyword is underlined.
function declarationKeywordLength(declaration) {
    if (declaration.isEnum) return 'enum'.length;
    return declaration.type === ASTNodeType.InterfaceDecl ? 'interface'.length : 'class'.length;
}

function checkDuplicatesWithinScope(declarations, errors) {
    const seen = new Set();
    for (const declaration of declarations ?? []) {
        if (seen.has(declaration.name)) {
            errors.push(semanticError(
                `Duplicate class '${declaration.name}'`, declaration, declarationKeywordLength(declaration)
            ));
        }
        seen.add(declaration.name);
        checkDuplicatesWithinScope(declaration.nestedClasses, errors);
    }
}

function describeExpectedArguments(candidates) {
    const descriptions = candidates.map(fn => {
        const parameters = fn.parameters ?? [];
        return parameters.some(parameter => parameter.isVarargs)
            ? `at least ${parameters.length - 1}`
            : String(parameters.length);
    });
    return [...new Set(descriptions)].join(' or ') + ' argument(s)';
}

function checkCall(node, context, errors, ownerDeclaration) {
    const callee = node.callee;
    if (callee?.type !== ASTNodeType.Identifier) return;
    const name = callee.name;
    const candidates = context.functionsByName.get(name);
    const isBuiltin = HAMSTER_BUILTIN_CALLS.has(name) || INHERITED_OBJECT_METHODS.has(name);
    if (!candidates) {
        if (isBuiltin || !context.resolvesAllNames || mayInheritUnknownMembers(ownerDeclaration, context)) {
            return;
        }
        errors.push(semanticError(`Unknown function '${name}'`, callee, name.length));
        return;
    }
    if (isBuiltin || mayInheritUnknownMembers(ownerDeclaration, context) ||
        candidates.some(fn => acceptsArgumentCount(fn, node.arguments.length))) return;
    errors.push(semanticError(
        `Function '${name}' expects ${describeExpectedArguments(candidates)} but got ${node.arguments.length}`,
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
    if (looksLikeTypeName(name) || context.classNames.has(name) ||
        mayInheritUnknownMembers(ownerDeclaration, context)) return;
    errors.push(semanticError(`Unknown variable '${name}'`, node, name.length));
}

function literalKind(literal) {
    if (literal.literalType === 'boolean') return 'boolean';
    if (literal.literalType === 'int') return 'int';
    if (literal.literalType === 'string') return 'String';
    return null;
}

// Source text is not kept on the node; escapes and radix make this an approximation.
function approximateLiteralLength(literal) {
    const text = literal.literalType === 'string' ? `"${literal.value}"` : String(literal.value);
    return Math.max(1, text.length);
}

function checkDeclarationInitializer(node, errors) {
    const initializer = node.initializer;
    if (initializer?.type !== ASTNodeType.Literal || !CHECKED_TARGET_TYPES.has(node.varType)) {
        return;
    }
    const kind = literalKind(initializer);
    if (!kind || COMPATIBLE_TYPES_BY_LITERAL[kind].has(node.varType)) return;
    errors.push(semanticError(
        `Type mismatch: cannot convert ${kind} to ${node.varType}`,
        initializer,
        approximateLiteralLength(initializer)
    ));
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
    checkDuplicatesWithinScope(ast.classes, errors);
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
