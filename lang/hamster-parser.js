import { HamsterLexer, HamsterLexerError, TokenType } from './hamster-lexer.js';

export const ASTNodeType = Object.freeze({
    Program: 'Program',
    ClassDecl: 'ClassDeclaration',
    InterfaceDecl: 'InterfaceDeclaration',
    FunctionDecl: 'FunctionDeclaration',
    FieldDecl: 'FieldDeclaration',
    ConstructorDecl: 'ConstructorDeclaration',
    Parameter: 'Parameter',
    Block: 'BlockStatement',
    VariableDecl: 'VariableDeclaration',
    Assignment: 'AssignmentStatement',
    ExpressionStmt: 'ExpressionStatement',
    IfStatement: 'IfStatement',
    WhileStatement: 'WhileStatement',
    DoWhileStatement: 'DoWhileStatement',
    ForStatement: 'ForStatement',
    SwitchStatement: 'SwitchStatement',
    SwitchCase: 'SwitchCase',
    BreakStatement: 'BreakStatement',
    TryStatement: 'TryStatement',
    ThrowStatement: 'ThrowStatement',
    ReturnStatement: 'ReturnStatement',
    ConditionalExpression: 'ConditionalExpression',
    BinaryExpression: 'BinaryExpression',
    UnaryExpression: 'UnaryExpression',
    PrefixExpression: 'PrefixExpression',
    PostfixExpression: 'PostfixExpression',
    Literal: 'Literal',
    Identifier: 'Identifier',
    CallExpression: 'CallExpression',
    MemberExpression: 'MemberExpression',
    IndexExpression: 'IndexExpression',
    NewExpression: 'NewExpression',
    ThisExpression: 'ThisExpression',
    SuperExpression: 'SuperExpression',
});

export class HamsterParserError extends Error {
    constructor(message, token) {
        const location = token ? ` (line ${token.line}, column ${token.column})` : '';
        super(message + location);
        this.name = 'HamsterParserError';
        this.token = token;
    }
}

export const ProgramType = Object.freeze({
    Imperative: 'imperative',
    ObjectOriented: 'object-oriented',
    Class: 'class',
    Scheme: 'scheme',
    Prolog: 'prolog',
    Python: 'python',
    JavaScript: 'javascript',
    Ruby: 'ruby',
    Lego: 'lego',
});

const PROGRAM_TYPE_MARKERS = new Map([
    ['imperative program', ProgramType.Imperative],
    ['object-oriented program', ProgramType.ObjectOriented],
    ['class', ProgramType.Class],
    ['scheme program', ProgramType.Scheme],
    ['prolog program', ProgramType.Prolog],
    ['python program', ProgramType.Python],
    ['javascript program', ProgramType.JavaScript],
    ['ruby program', ProgramType.Ruby],
    ['lego program', ProgramType.Lego],
]);

function readProgramTypeMarker(source) {
    const marker = /^\uFEFF?\s*\/\*\s*([^*]+?)\s*\*\//.exec(source ?? '');
    if (!marker) return null;
    const markerText = marker[1];
    if (PROGRAM_TYPE_MARKERS.has(markerText) || markerText.endsWith('program')) {
        return markerText;
    }
    return null;
}

export function detectProgramType(source) {
    const marker = readProgramTypeMarker(source);
    return marker ? PROGRAM_TYPE_MARKERS.get(marker) : ProgramType.Imperative;
}

export function parseProgram(source, options = {}) {
    const marker = readProgramTypeMarker(source);
    const programType = marker ? PROGRAM_TYPE_MARKERS.get(marker) : ProgramType.Imperative;
    if (marker && !programType) {
        throw new HamsterParserError(
            `Unsupported program type marker '${marker}'`,
            { line: 1, column: 1 }
        );
    }
    const supportedTypes = new Set([
        ProgramType.Imperative,
        ProgramType.ObjectOriented,
        ProgramType.Class,
    ]);
    if (!supportedTypes.has(programType)) {
        throw new HamsterParserError(
            `Program type '${programType}' is not supported by this extension`,
            { line: 1, column: 1 }
        );
    }
    const parserOptions = {
        ...options,
        compatibility: options.compatibility !== undefined
            ? options.compatibility
            : true,
        requireMain: options.requireMain !== undefined
            ? options.requireMain
            : programType !== ProgramType.Class,
    };
    if (options.strict === undefined) {
        parserOptions.strict = parserOptions.requireMain;
    }
    const ast = new Parser(source, parserOptions).parseProgram();
    return { ...ast, programType };
}

export function collectProgramErrors(source, options = {}) {
    const errors = [];
    try {
        parseProgram(source, {
            ...options,
            strict: true,
            errors,
        });
    } catch (error) {
        if (!isLanguageError(error)) {
            throw error;
        }
        if (!errors.includes(error)) {
            errors.push(error);
        }
    }
    return errors;
}

class Parser {
    constructor(source, options = {}) {
        this.errors = Array.isArray(options.errors) ? options.errors : null;
        this.tokens = new HamsterLexer(source).tokenize(this.errors);
        this.current = 0;
        this.breakableDepth = 0;
        this.options = {
            requireMain: options.requireMain !== undefined ? options.requireMain : true,
            compatibility: options.compatibility === true,
            strict: options.strict === true,
        };
    }

    parseProgram() {
        if (this.options.compatibility) {
            return this.parseCompatibilityProgram();
        }
        if (this.isAtEnd()) {
            if (this.options.requireMain) {
                throw new HamsterParserError('Program must define void main()', this.peek());
            }
            return { type: ASTNodeType.Program, functions: [], globals: [], classes: [] };
        }
        const functions = [];
        const globals = [];
        // Parse global variable declarations before main()
        while (!this.isAtEnd() && this.isTypeKeywordAhead() && !this.isFunctionAhead()) {
            globals.push(this.parseVariableDeclaration());
        }
        if (this.isAtEnd()) {
            if (this.options.requireMain) {
                throw new HamsterParserError('Program must define void main()', this.peek());
            }
            return { type: ASTNodeType.Program, functions, globals, classes: [] };
        }
        functions.push(this.parseFunction(this.options.requireMain));
        while (!this.isAtEnd()) {
            functions.push(this.parseFunction(false));
        }
        return { type: ASTNodeType.Program, functions, globals, classes: [] };
    }

    parseCompatibilityProgram() {
        const functions = [];
        const globals = [];
        const classes = [];
        while (!this.isAtEnd()) {
            const declarationStart = this.current;
            try {
                if (this.checkKeyword('package') || this.checkKeyword('import')) {
                    this.skipUntilSymbol(';');
                    continue;
                }
                if (this.isClassLikeDeclarationAhead()) {
                    const declaration = this.parseClassLikeDeclaration();
                    classes.push(declaration);
                    functions.push(...collectClassMethods(declaration));
                    continue;
                }
                const fn = this.tryParseFunction(true);
                if (fn) {
                    functions.push(fn);
                    continue;
                }
                const varDecl = this.tryParseGlobalVariable();
                if (varDecl) {
                    globals.push(varDecl);
                    continue;
                }
                if (this.options.strict) {
                    // Re-run a strict function parse to surface the precise error.
                    this.parseFunction(false);
                    throw new HamsterParserError(
                        `Unexpected token '${this.peek().value ?? this.peek().type}' at top level`,
                        this.peek()
                    );
                }
                this.advance();
            } catch (error) {
                if (!this.captureError(error)) {
                    throw error;
                }
                this.synchronizeTopLevel(declarationStart);
            }
        }
        if (this.options.requireMain &&
            !functions.some(fn => fn.name === 'main' && fn.returnType === 'void' && fn.body)) {
            throw new HamsterParserError('Program must define void main()', this.peek());
        }
        return { type: ASTNodeType.Program, functions, globals, classes };
    }

    isClassLikeDeclarationAhead() {
        let idx = this.current;
        while (this.isModifierToken(this.tokens[idx])) {
            idx += 1;
        }
        const token = this.tokens[idx];
        return token?.type === TokenType.KEYWORD &&
            (token.value === 'class' || token.value === 'interface');
    }

    parseClassLikeDeclaration(leadingModifiers = null) {
        const modifiers = leadingModifiers || this.parseModifiers();
        const kindToken = this.advance();
        const nameToken = this.consumeIdentifier(`Expected ${kindToken.value} name`);
        const isInterface = kindToken.value === 'interface';
        let superClass = null;
        const interfaces = [];

        if (this.matchKeyword('extends')) {
            if (isInterface) {
                do {
                    interfaces.push(this.consumeQualifiedName('Expected interface name after extends'));
                } while (this.matchSymbol(','));
            } else {
                superClass = this.consumeQualifiedName('Expected superclass name after extends');
            }
        }
        if (!isInterface && this.matchKeyword('implements')) {
            do {
                interfaces.push(this.consumeQualifiedName('Expected interface name after implements'));
            } while (this.matchSymbol(','));
        }

        this.consumeSymbol('{', `Expected { to start ${kindToken.value} body`);
        const fields = [];
        const constructors = [];
        const methods = [];
        const nestedClasses = [];
        const initializerBlocks = [];
        let initializationOrder = 0;
        while (!this.checkSymbol('}') && !this.isAtEnd()) {
            if (this.matchSymbol(';')) {
                continue;
            }
            const memberModifiers = this.parseModifiers();
            if (this.checkSymbol('{')) {
                if (memberModifiers.some(modifier => modifier !== 'static')) {
                    throw new HamsterParserError('Initializer blocks may only be static', this.peek());
                }
                initializerBlocks.push({
                    body: this.parseBlock(),
                    isStatic: memberModifiers.includes('static'),
                    order: initializationOrder++,
                });
                continue;
            }
            if (this.checkKeyword('class') || this.checkKeyword('interface')) {
                nestedClasses.push(this.parseClassLikeDeclaration(memberModifiers));
                continue;
            }
            if (!isInterface && this.checkToken(TokenType.IDENTIFIER) &&
                this.peek().value === nameToken.value && this.checkNextSymbol('(')) {
                constructors.push(this.parseConstructor(nameToken.value, memberModifiers));
                continue;
            }
            const typeToken = this.consumeTypeName(true);
            while (this.matchSymbol('[')) {
                this.consumeSymbol(']', 'Expected ] after [ in member type');
            }
            const memberName = this.consumeIdentifier('Expected member name');
            if (this.checkSymbol('(')) {
                methods.push(this.parseMethodRest(
                    memberName,
                    typeToken.value,
                    memberModifiers,
                    nameToken.value,
                    isInterface
                ));
                continue;
            }
            if (typeToken.value === 'void') {
                throw new HamsterParserError('Fields cannot have type void', typeToken);
            }
            const declarations = this.parseFieldRest(memberName, typeToken.value, memberModifiers);
            for (const field of declarations) {
                field.order = initializationOrder++;
                fields.push(field);
            }
        }
        this.consumeSymbol('}', `Expected } to close ${kindToken.value} body`);

        return {
            type: isInterface ? ASTNodeType.InterfaceDecl : ASTNodeType.ClassDecl,
            name: nameToken.value,
            superClass,
            interfaces,
            modifiers,
            fields,
            constructors,
            methods,
            nestedClasses,
            initializerBlocks,
            loc: locationFrom(kindToken),
        };
    }

    parseConstructor(className, modifiers) {
        const nameToken = this.consumeIdentifier('Expected constructor name');
        const parameters = this.parseParameterList();
        this.parseThrowsClause();
        const body = this.parseBlock();
        return {
            type: ASTNodeType.ConstructorDecl,
            name: className,
            parameters,
            body,
            modifiers,
            loc: locationFrom(nameToken),
        };
    }

    parseMethodRest(nameToken, returnType, modifiers, owner, allowAbstract) {
        const parameters = this.parseParameterList();
        this.parseThrowsClause();
        let body = null;
        if (this.matchSymbol(';')) {
            if (!allowAbstract && !modifiers.includes('abstract')) {
                throw new HamsterParserError('Expected method body', this.previous());
            }
        } else {
            body = this.parseBlock();
        }
        return {
            type: ASTNodeType.FunctionDecl,
            name: nameToken.value,
            returnType,
            parameters,
            body,
            modifiers,
            owner,
            loc: locationFrom(nameToken),
        };
    }

    parseFieldRest(nameToken, varType, modifiers) {
        const fields = [];
        let currentName = nameToken;
        do {
            while (this.matchSymbol('[')) {
                this.consumeSymbol(']', 'Expected ] after [ in field declarator');
            }
            let initializer = null;
            if (this.matchOperator('=')) {
                initializer = this.parseExpression();
            }
            fields.push({
                type: ASTNodeType.FieldDecl,
                varType,
                name: currentName.value,
                initializer,
                modifiers,
                loc: locationFrom(currentName),
            });
            if (!this.matchSymbol(',')) {
                break;
            }
            currentName = this.consumeIdentifier('Expected field name after comma');
        } while (true);
        this.consumeSymbol(';', 'Expected ; after field declaration');
        return fields;
    }

    parseParameterList() {
        this.consumeSymbol('(', 'Expected ( before parameter list');
        const parameters = [];
        if (!this.checkSymbol(')')) {
            do {
                parameters.push(this.parseParameter());
            } while (this.matchSymbol(','));
        }
        this.consumeSymbol(')', 'Expected ) after parameter list');
        return parameters;
    }

    parseThrowsClause() {
        if (!this.matchKeyword('throws')) {
            return;
        }
        do {
            this.consumeQualifiedName('Expected exception type after throws');
        } while (this.matchSymbol(','));
    }

    parseFunction(requireMain) {
        this.skipModifiers();
        const returnToken = this.consumeTypeName(true);
        const nameToken = this.consumeIdentifier('Expected function name');
        if (requireMain) {
            if (returnToken.value !== 'void' || nameToken.value !== 'main') {
                throw new HamsterParserError('First function must be void main()', nameToken);
            }
        }
        this.consumeSymbol('(', 'Expected ( after function name');
        const parameters = [];
        if (!this.checkSymbol(')')) {
            do {
                parameters.push(this.parseParameter());
            } while (this.matchSymbol(','));
        }
        this.consumeSymbol(')', 'Expected ) after parameter list');
        const body = this.parseBlock();
        return {
            type: ASTNodeType.FunctionDecl,
            name: nameToken.value,
            returnType: returnToken.value,
            parameters,
            body,
            loc: locationFrom(nameToken),
        };
    }

    parseParameter() {
        this.skipModifiers();
        const typeToken = this.consumeTypeName(false);

        // Accept both `Type[] name` and `Type name[]` parameter forms.
        while (this.matchSymbol('[')) {
            this.consumeSymbol(']', 'Expected ] after [ in parameter type');
        }

        const nameToken = this.consumeIdentifier('Expected parameter name');
        while (this.matchSymbol('[')) {
            this.consumeSymbol(']', 'Expected ] after [ in parameter type');
        }
        return {
            type: ASTNodeType.Parameter,
            name: nameToken.value,
            paramType: typeToken.value,
            loc: locationFrom(nameToken),
        };
    }

    parseBlock() {
        const lbrace = this.consumeSymbol('{', 'Expected { to start block');
        const statements = [];
        while (!this.checkSymbol('}') && !this.isAtEnd()) {
            const statementStart = this.current;
            try {
                statements.push(this.parseStatement());
            } catch (error) {
                if (!this.captureError(error)) {
                    throw error;
                }
                this.synchronizeStatement(statementStart);
            }
        }
        this.consumeSymbol('}', 'Expected } to close block');
        return {
            type: ASTNodeType.Block,
            statements,
            loc: locationFrom(lbrace),
        };
    }

    parseStatement() {
        if (this.matchSymbol(';')) {
            return {
                type: ASTNodeType.Block,
                statements: [],
                loc: locationFrom(this.previous()),
            };
        }
        if (this.checkSymbol('{')) {
            return this.parseBlock();
        }
        if (this.checkKeyword('if')) {
            return this.parseIfStatement();
        }
        if (this.checkKeyword('do')) {
            return this.parseDoWhileStatement();
        }
        if (this.checkKeyword('while')) {
            return this.parseWhileStatement();
        }
        if (this.checkKeyword('for')) {
            return this.parseForStatement();
        }
        if (this.checkKeyword('switch')) {
            return this.parseSwitchStatement();
        }
        if (this.checkKeyword('try')) {
            return this.parseTryStatement();
        }
        if (this.checkKeyword('throw')) {
            return this.parseThrowStatement();
        }
        if (this.checkKeyword('break')) {
            return this.parseBreakStatement();
        }
        if (this.checkKeyword('return')) {
            return this.parseReturnStatement();
        }
        if (this.isTypeKeywordAhead()) {
            return this.parseVariableDeclaration();
        }
        if (this.isAssignmentAhead()) {
            return this.parseAssignmentStatement();
        }
        return this.parseExpressionStatement();
    }

    parseDoWhileStatement() {
        const doToken = this.consumeKeyword('do', 'Expected do');
        const body = this.parseBreakableStatement();
        this.consumeKeyword('while', 'Expected while after do-body');
        this.consumeSymbol('(', 'Expected ( after while');
        const test = this.parseExpression();
        this.consumeSymbol(')', 'Expected ) after condition');
        this.consumeSymbol(';', 'Expected ; after do-while');
        return {
            type: ASTNodeType.DoWhileStatement,
            test,
            body,
            loc: locationFrom(doToken),
        };
    }

    parseIfStatement() {
        const ifToken = this.consumeKeyword('if', 'Expected if');
        this.consumeSymbol('(', 'Expected ( after if');
        const test = this.parseExpression();
        this.consumeSymbol(')', 'Expected ) after condition');
        const consequent = this.parseStatement();
        let alternate = null;
        if (this.matchKeyword('else')) {
            alternate = this.parseStatement();
        }
        return {
            type: ASTNodeType.IfStatement,
            test,
            consequent,
            alternate,
            loc: locationFrom(ifToken),
        };
    }

    parseWhileStatement() {
        const whileToken = this.consumeKeyword('while', 'Expected while');
        this.consumeSymbol('(', 'Expected ( after while');
        const test = this.parseExpression();
        this.consumeSymbol(')', 'Expected ) after condition');
        const body = this.parseBreakableStatement();
        return {
            type: ASTNodeType.WhileStatement,
            test,
            body,
            loc: locationFrom(whileToken),
        };
    }

    parseReturnStatement() {
        const returnToken = this.consumeKeyword('return', 'Expected return');
        let argument = null;
        if (!this.checkSymbol(';')) {
            argument = this.parseExpression();
        }
        this.consumeSymbol(';', 'Expected ; after return');
        return {
            type: ASTNodeType.ReturnStatement,
            argument,
            loc: locationFrom(returnToken),
        };
    }

    parseSwitchStatement() {
        const switchToken = this.consumeKeyword('switch', 'Expected switch');
        this.consumeSymbol('(', 'Expected ( after switch');
        const discriminant = this.parseExpression();
        this.consumeSymbol(')', 'Expected ) after switch expression');
        this.consumeSymbol('{', 'Expected { to start switch');

        const cases = [];
        let hasDefault = false;
        this.breakableDepth += 1;
        try {
            while (!this.checkSymbol('}') && !this.isAtEnd()) {
                let test = null;
                let clauseToken;
                if (this.matchKeyword('case')) {
                    clauseToken = this.previous();
                    test = this.parseExpression();
                } else if (this.matchKeyword('default')) {
                    clauseToken = this.previous();
                    if (hasDefault) {
                        throw new HamsterParserError('Switch may only contain one default clause', clauseToken);
                    }
                    hasDefault = true;
                } else {
                    throw new HamsterParserError('Expected case or default in switch', this.peek());
                }
                this.consumeSymbol(':', 'Expected : after switch label');
                const statements = [];
                while (!this.checkKeyword('case') &&
                       !this.checkKeyword('default') &&
                       !this.checkSymbol('}') &&
                       !this.isAtEnd()) {
                    statements.push(this.parseStatement());
                }
                cases.push({
                    type: ASTNodeType.SwitchCase,
                    test,
                    statements,
                    loc: locationFrom(clauseToken),
                });
            }
        } finally {
            this.breakableDepth -= 1;
        }
        this.consumeSymbol('}', 'Expected } to close switch');
        return {
            type: ASTNodeType.SwitchStatement,
            discriminant,
            cases,
            loc: locationFrom(switchToken),
        };
    }

    parseTryStatement() {
        const tryToken = this.consumeKeyword('try', 'Expected try');
        const block = this.parseBlock();
        if (this.peek().value === 'finally') {
            throw new HamsterParserError('finally clauses are not supported', this.peek());
        }
        this.consumeKeyword('catch', 'Expected catch after try block');
        this.consumeSymbol('(', 'Expected ( after catch');
        const typeToken = this.consumeTypeName(false);
        const parameter = this.consumeIdentifier('Expected catch parameter name');
        this.consumeSymbol(')', 'Expected ) after catch parameter');
        const handler = this.parseBlock();
        if (this.checkKeyword('catch')) {
            throw new HamsterParserError('Multiple catch clauses are not supported', this.peek());
        }
        if (this.peek().value === 'finally') {
            throw new HamsterParserError('finally clauses are not supported', this.peek());
        }
        return {
            type: ASTNodeType.TryStatement,
            block,
            handler: {
                paramType: typeToken.value,
                paramName: parameter.value,
                body: handler,
                loc: locationFrom(typeToken),
            },
            loc: locationFrom(tryToken),
        };
    }

    parseThrowStatement() {
        const throwToken = this.consumeKeyword('throw', 'Expected throw');
        const argument = this.parseExpression();
        this.consumeSymbol(';', 'Expected ; after throw');
        return {
            type: ASTNodeType.ThrowStatement,
            argument,
            loc: locationFrom(throwToken),
        };
    }

    parseBreakStatement() {
        const breakToken = this.consumeKeyword('break', 'Expected break');
        if (this.breakableDepth === 0) {
            throw new HamsterParserError('break is only valid inside a loop or switch', breakToken);
        }
        this.consumeSymbol(';', 'Expected ; after break');
        return {
            type: ASTNodeType.BreakStatement,
            loc: locationFrom(breakToken),
        };
    }

    parseBreakableStatement() {
        this.breakableDepth += 1;
        try {
            return this.parseStatement();
        } finally {
            this.breakableDepth -= 1;
        }
    }

    parseForStatement() {
        const forToken = this.consumeKeyword('for', 'Expected for');
        this.consumeSymbol('(', 'Expected ( after for');

        let initializer = null;
        if (!this.checkSymbol(';')) {
            if (this.isTypeKeywordAhead()) {
                initializer = this.parseForVariableDeclaration();
            } else if (this.isAssignmentAhead()) {
                initializer = this.parseForAssignment();
            } else {
                const expr = this.parseExpression();
                initializer = {
                    type: ASTNodeType.ExpressionStmt,
                    expression: expr,
                    loc: expr.loc,
                };
            }
        }
        this.consumeSymbol(';', 'Expected ; after for-loop initializer');

        let test = null;
        if (!this.checkSymbol(';')) {
            test = this.parseExpression();
        }
        this.consumeSymbol(';', 'Expected ; after for-loop condition');

        let update = null;
        if (!this.checkSymbol(')')) {
            if (this.isAssignmentAhead()) {
                update = this.parseForAssignment();
            } else {
                const expr = this.parseExpression();
                update = {
                    type: ASTNodeType.ExpressionStmt,
                    expression: expr,
                    loc: expr.loc,
                };
            }
        }
        this.consumeSymbol(')', 'Expected ) after for-loop update');

        const body = this.parseBreakableStatement();
        let whileBody = body;
        if (update) {
            if (whileBody.type === ASTNodeType.Block) {
                whileBody = {
                    ...whileBody,
                    statements: [...whileBody.statements, update],
                };
            } else {
                whileBody = {
                    type: ASTNodeType.Block,
                    statements: [whileBody, update],
                    loc: body.loc || locationFrom(forToken),
                };
            }
        }

        const whileNode = {
            type: ASTNodeType.WhileStatement,
            test: test || {
                type: ASTNodeType.Literal,
                value: true,
                literalType: 'boolean',
                loc: locationFrom(forToken),
            },
            body: whileBody,
            loc: locationFrom(forToken),
        };

        if (!initializer) {
            return whileNode;
        }

        return {
            type: ASTNodeType.Block,
            statements: [initializer, whileNode],
            loc: locationFrom(forToken),
        };
    }

    parseForVariableDeclaration() {
        this.skipModifiers();
        const typeToken = this.consumeTypeName(false);
        while (this.matchSymbol('[')) {
            this.consumeSymbol(']', 'Expected ] after [ in variable type');
        }
        const nameToken = this.consumeIdentifier('Expected variable name');
        while (this.matchSymbol('[')) {
            this.consumeSymbol(']', 'Expected ] after [ in variable name declarator');
        }

        let initializer = null;
        if (this.matchOperator('=')) {
            initializer = this.parseExpression();
        }

        return {
            type: ASTNodeType.VariableDecl,
            varType: typeToken.value,
            name: nameToken.value,
            initializer,
            loc: locationFrom(nameToken),
        };
    }

    parseForAssignment() {
        const target = this.parseAssignableExpression();
        const operator = this.consumeAssignmentOperator();
        const value = this.parseExpression();
        return {
            type: ASTNodeType.Assignment,
            name: target.type === ASTNodeType.Identifier ? target.name : null,
            target,
            operator: operator.value,
            value,
            loc: target.loc,
        };
    }

    parseVariableDeclaration() {
        this.skipModifiers();
        const typeToken = this.consumeTypeName(false);
        while (this.matchSymbol('[')) {
            this.consumeSymbol(']', 'Expected ] after [ in variable type');
        }
        const nameToken = this.consumeIdentifier('Expected variable name');
        while (this.matchSymbol('[')) {
            // Skip array declarator after variable name (e.g., int a[])
            this.consumeSymbol(']', 'Expected ] after [ in variable name declarator');
        }
        let initializer = null;
        if (this.matchOperator('=')) {
            initializer = this.parseExpression();
        }
        this.consumeSymbol(';', 'Expected ; after variable declaration');
        return {
            type: ASTNodeType.VariableDecl,
            varType: typeToken.value,
            name: nameToken.value,
            initializer,
            loc: locationFrom(nameToken),
        };
    }

    parseAssignmentStatement() {
        const target = this.parseAssignableExpression();
        const operator = this.consumeAssignmentOperator();
        const value = this.parseExpression();
        this.consumeSymbol(';', 'Expected ; after assignment');
        return {
            type: ASTNodeType.Assignment,
            name: target.type === ASTNodeType.Identifier ? target.name : null,
            target,
            operator: operator.value,
            value,
            loc: target.loc,
        };
    }

    consumeAssignmentOperator() {
        if (this.matchOperator('=') || this.matchOperator('+=') || this.matchOperator('-=')) {
            return this.previous();
        }
        throw new HamsterParserError('Expected =, +=, or -= in assignment', this.peek());
    }

    parseExpressionStatement() {
        const expr = this.parseExpression();
        this.consumeSymbol(';', 'Expected ; after expression');
        return {
            type: ASTNodeType.ExpressionStmt,
            expression: expr,
            loc: expr.loc,
        };
    }

    parseExpression() {
        return this.parseConditional();
    }

    parseConditional() {
        const test = this.parseLogicalOr();
        if (!this.matchSymbol('?')) {
            return test;
        }
        const consequent = this.parseExpression();
        this.consumeSymbol(':', 'Expected : in conditional expression');
        const alternate = this.parseExpression();
        return {
            type: ASTNodeType.ConditionalExpression,
            test,
            consequent,
            alternate,
            loc: test.loc,
        };
    }

    parseLogicalOr() {
        let expr = this.parseLogicalAnd();
        while (this.matchOperator('||')) {
            const operator = this.previous();
            const right = this.parseLogicalAnd();
            expr = makeBinary(operator, expr, right);
        }
        return expr;
    }

    parseLogicalAnd() {
        let expr = this.parseEquality();
        while (this.matchOperator('&&')) {
            const operator = this.previous();
            const right = this.parseEquality();
            expr = makeBinary(operator, expr, right);
        }
        return expr;
    }

    parseEquality() {
        let expr = this.parseRelational();
        while (this.matchOperator('==') || this.matchOperator('!=')) {
            const operator = this.previous();
            const right = this.parseRelational();
            expr = makeBinary(operator, expr, right);
        }
        return expr;
    }

    parseRelational() {
        let expr = this.parseAdditive();
        while (this.matchOperator('<') || this.matchOperator('>') ||
               this.matchOperator('<=') || this.matchOperator('>=')) {
            const operator = this.previous();
            const right = this.parseAdditive();
            expr = makeBinary(operator, expr, right);
        }
        return expr;
    }

    parseAdditive() {
        let expr = this.parseMultiplicative();
        while (this.matchOperator('+') || this.matchOperator('-')) {
            const operator = this.previous();
            const right = this.parseMultiplicative();
            expr = makeBinary(operator, expr, right);
        }
        return expr;
    }

    parseMultiplicative() {
        let expr = this.parseUnary();
        while (this.matchOperator('*') || this.matchOperator('/') || this.matchOperator('%')) {
            const operator = this.previous();
            const right = this.parseUnary();
            expr = makeBinary(operator, expr, right);
        }
        return expr;
    }

    parseUnary() {
        if (this.matchOperator('++') || this.matchOperator('--')) {
            const operator = this.previous();
            const argument = this.parseUnary();
            this.ensureAssignableUpdateTarget(argument, operator);
            return {
                type: ASTNodeType.PrefixExpression,
                operator: operator.value,
                argument,
                loc: locationFrom(operator),
            };
        }
        if (this.matchOperator('!') || this.matchOperator('-')) {
            const operator = this.previous();
            const argument = this.parseUnary();
            return {
                type: ASTNodeType.UnaryExpression,
                operator: operator.value,
                argument,
                loc: locationFrom(operator),
            };
        }
        return this.parsePostfix();
    }

    parsePostfix() {
        let expr = this.parsePrimary();
        while (true) {
            if (this.matchSymbol('(')) {
                const args = [];
                if (!this.checkSymbol(')')) {
                    do {
                        args.push(this.parseExpression());
                    } while (this.matchSymbol(','));
                }
                this.consumeSymbol(')', 'Expected ) to close argument list');
                expr = {
                    type: ASTNodeType.CallExpression,
                    callee: expr,
                    arguments: args,
                    loc: expr.loc,
                };
                continue;
            }
            if (this.matchSymbol('.')) {
                const property = this.consumeIdentifier('Expected member name after .');
                expr = {
                    type: ASTNodeType.MemberExpression,
                    object: expr,
                    property: property.value,
                    loc: expr.loc,
                };
                continue;
            }
            if (this.matchSymbol('[')) {
                const index = this.parseExpression();
                this.consumeSymbol(']', 'Expected ] after index expression');
                expr = {
                    type: ASTNodeType.IndexExpression,
                    object: expr,
                    index,
                    loc: expr.loc,
                };
                continue;
            }
            break;
        }
        if (this.matchOperator('++') || this.matchOperator('--')) {
            const operator = this.previous();
            this.ensureAssignableUpdateTarget(expr, operator);
            expr = {
                type: ASTNodeType.PostfixExpression,
                operator: operator.value,
                argument: expr,
                loc: locationFrom(operator),
            };
        }
        return expr;
    }

    ensureAssignableUpdateTarget(argument, operator) {
        if (argument.type === ASTNodeType.Identifier ||
            argument.type === ASTNodeType.MemberExpression ||
            argument.type === ASTNodeType.IndexExpression) {
            return;
        }
        throw new HamsterParserError(
            `Operator ${operator.value} requires an assignable target`,
            operator
        );
    }

    parsePrimary() {
        if (this.matchToken(TokenType.INTEGER)) {
            const token = this.previous();
            return {
                type: ASTNodeType.Literal,
                value: Number(token.value),
                literalType: 'int',
                loc: locationFrom(token),
            };
        }
        if (this.matchToken(TokenType.BOOLEAN)) {
            const token = this.previous();
            return {
                type: ASTNodeType.Literal,
                value: token.value,
                literalType: 'boolean',
                loc: locationFrom(token),
            };
        }
        if (this.matchToken(TokenType.STRING)) {
            const token = this.previous();
            return {
                type: ASTNodeType.Literal,
                value: token.value,
                literalType: 'string',
                loc: locationFrom(token),
            };
        }
        if (this.matchToken(TokenType.NULL)) {
            const token = this.previous();
            return {
                type: ASTNodeType.Literal,
                value: null,
                literalType: 'null',
                loc: locationFrom(token),
            };
        }
        if (this.matchKeyword('this')) {
            const token = this.previous();
            return {
                type: ASTNodeType.ThisExpression,
                loc: locationFrom(token),
            };
        }
        if (this.matchKeyword('super')) {
            const token = this.previous();
            return {
                type: ASTNodeType.SuperExpression,
                loc: locationFrom(token),
            };
        }
        if (this.matchKeyword('new')) {
            const newToken = this.previous();
            const ctorName = this.consumeIdentifier('Expected constructor/type name after new');
            let callee = {
                type: ASTNodeType.Identifier,
                name: ctorName.value,
                loc: locationFrom(ctorName),
            };
            while (this.matchSymbol('.')) {
                const member = this.consumeIdentifier('Expected member name after .');
                callee = {
                    type: ASTNodeType.MemberExpression,
                    object: callee,
                    property: member.value,
                    loc: callee.loc,
                };
            }

            if (this.matchSymbol('(')) {
                const args = [];
                if (!this.checkSymbol(')')) {
                    do {
                        args.push(this.parseExpression());
                    } while (this.matchSymbol(','));
                }
                this.consumeSymbol(')', 'Expected ) after constructor arguments');
                return {
                    type: ASTNodeType.NewExpression,
                    callee,
                    arguments: args,
                    dimensions: [],
                    loc: locationFrom(newToken),
                };
            }

            const dimensions = [];
            while (this.matchSymbol('[')) {
                if (!this.checkSymbol(']')) {
                    dimensions.push(this.parseExpression());
                } else {
                    dimensions.push(null);
                }
                this.consumeSymbol(']', 'Expected ] after array dimension');
            }
            if (dimensions.length > 0) {
                return {
                    type: ASTNodeType.NewExpression,
                    callee,
                    arguments: [],
                    dimensions,
                    loc: locationFrom(newToken),
                };
            }

            throw new HamsterParserError('Expected constructor call or array dimension after new', this.peek());
        }
        if (this.matchToken(TokenType.IDENTIFIER)) {
            const identifier = this.previous();
            return {
                type: ASTNodeType.Identifier,
                name: identifier.value,
                loc: locationFrom(identifier),
            };
        }
        if (this.matchSymbol('(')) {
            const expr = this.parseExpression();
            this.consumeSymbol(')', 'Expected ) after expression');
            return expr;
        }
        throw new HamsterParserError('Unexpected token in expression', this.peek());
    }

    isAssignmentAhead() {
        if (!this.checkToken(TokenType.IDENTIFIER) &&
            !this.checkKeyword('this') &&
            !this.checkKeyword('super')) return false;
        let idx = this.current + 1;
        while (idx < this.tokens.length) {
            const token = this.tokens[idx];
            if (token.type === TokenType.SYMBOL && token.value === '.') {
                if (this.tokens[idx + 1]?.type !== TokenType.IDENTIFIER) return false;
                idx += 2;
                continue;
            }
            if (token.type === TokenType.SYMBOL && token.value === '[') {
                let depth = 1;
                idx += 1;
                while (idx < this.tokens.length && depth > 0) {
                    const t = this.tokens[idx];
                    if (t.type === TokenType.SYMBOL && t.value === '[') depth += 1;
                    if (t.type === TokenType.SYMBOL && t.value === ']') depth -= 1;
                    idx += 1;
                }
                if (depth !== 0) return false;
                continue;
            }
            return token.type === TokenType.OPERATOR &&
                (token.value === '=' || token.value === '+=' || token.value === '-=');
        }
        return false;
    }

    isTypeKeywordAhead() {
        if (this.checkKeyword('int') || this.checkKeyword('boolean')) {
            return true;
        }
        if (this.checkToken(TokenType.IDENTIFIER)) {
            let idx = this.current + 1;
            while (idx < this.tokens.length && this.tokens[idx]?.type === TokenType.SYMBOL && this.tokens[idx].value === '[') {
                if (this.tokens[idx + 1]?.type !== TokenType.SYMBOL || this.tokens[idx + 1]?.value !== ']') {
                    return false;
                }
                idx += 2;
            }
            if (this.tokens[idx]?.type === TokenType.IDENTIFIER) {
                return true;
            }
        }
        return false;
    }

    consumeTypeName(allowVoid) {
        if (allowVoid && this.checkKeyword('void')) {
            return this.advance();
        }
        if (this.checkKeyword('int') || this.checkKeyword('boolean')) {
            return this.advance();
        }
        if (this.checkToken(TokenType.IDENTIFIER)) {
            return this.advance();
        }
        throw new HamsterParserError('Expected type keyword', this.peek());
    }

    parseAssignableExpression() {
        let target;
        if (this.matchKeyword('this')) {
            const token = this.previous();
            target = {
                type: ASTNodeType.ThisExpression,
                loc: locationFrom(token),
            };
        } else if (this.matchKeyword('super')) {
            const token = this.previous();
            target = {
                type: ASTNodeType.SuperExpression,
                loc: locationFrom(token),
            };
        } else {
            const identifier = this.consumeIdentifier('Expected assignment target');
            target = {
                type: ASTNodeType.Identifier,
                name: identifier.value,
                loc: locationFrom(identifier),
            };
        }

        while (true) {
            if (this.matchSymbol('.')) {
                const property = this.consumeIdentifier('Expected member name after .');
                target = {
                    type: ASTNodeType.MemberExpression,
                    object: target,
                    property: property.value,
                    loc: target.loc,
                };
                continue;
            }
            if (this.matchSymbol('[')) {
                const index = this.parseExpression();
                this.consumeSymbol(']', 'Expected ] after index expression');
                target = {
                    type: ASTNodeType.IndexExpression,
                    object: target,
                    index,
                    loc: target.loc,
                };
                continue;
            }
            break;
        }

        return target;
    }

    skipModifiers() {
        this.parseModifiers();
    }

    parseModifiers() {
        const modifiers = [];
        while (this.isModifierToken(this.peek())) {
            modifiers.push(this.advance().value);
        }
        return modifiers;
    }

    isModifierToken(token) {
        return token?.type === TokenType.KEYWORD &&
            (token.value === 'public' || token.value === 'private' ||
             token.value === 'protected' || token.value === 'static' ||
             token.value === 'final' || token.value === 'abstract');
    }

    consumeQualifiedName(message) {
        const first = this.consumeIdentifier(message);
        let name = first.value;
        while (this.matchSymbol('.')) {
            name += '.' + this.consumeIdentifier(message).value;
        }
        return name;
    }

    checkNextSymbol(symbol) {
        const token = this.tokens[this.current + 1];
        return token?.type === TokenType.SYMBOL && token.value === symbol;
    }

    tryParseGlobalVariable() {
        const checkpoint = this.current;
        try {
            this.skipModifiers();
            if (!this.isTypeKeywordAhead()) {
                this.current = checkpoint;
                return null;
            }
            const typeToken = this.consumeTypeName(false);
            while (this.matchSymbol('[')) {
                this.consumeSymbol(']', 'Expected ] after [ in variable type');
            }
            const nameToken = this.consumeIdentifier('Expected variable name');
            while (this.matchSymbol('[')) {
                this.consumeSymbol(']', 'Expected ] after [ in variable name declarator');
            }
            // Must be followed by '=' or ';' — not '(' (that would be a function)
            if (this.checkSymbol('(')) {
                this.current = checkpoint;
                return null;
            }
            let initializer = null;
            if (this.matchOperator('=')) {
                initializer = this.parseExpression();
            }
            this.consumeSymbol(';', 'Expected ; after variable declaration');
            return {
                type: ASTNodeType.VariableDecl,
                varType: typeToken.value,
                name: nameToken.value,
                initializer,
                loc: locationFrom(nameToken),
            };
        } catch (error) {
            this.current = checkpoint;
            return null;
        }
    }

    isFunctionAhead() {
        let idx = this.current;
        // skip modifiers
        while (idx < this.tokens.length) {
            const t = this.tokens[idx];
            if (t.type === TokenType.KEYWORD && (t.value === 'public' || t.value === 'private' ||
                t.value === 'protected' || t.value === 'static' || t.value === 'final' ||
                t.value === 'abstract')) {
                idx++;
            } else {
                break;
            }
        }
        // skip return type
        const typeToken = this.tokens[idx];
        if (!typeToken) return false;
        if (typeToken.type === TokenType.KEYWORD && (typeToken.value === 'void' || typeToken.value === 'int' || typeToken.value === 'boolean')) {
            idx++;
        } else if (typeToken.type === TokenType.IDENTIFIER) {
            idx++;
        } else {
            return false;
        }
        // skip array brackets on type
        while (idx < this.tokens.length && this.tokens[idx]?.type === TokenType.SYMBOL && this.tokens[idx].value === '[') {
            if (this.tokens[idx + 1]?.type !== TokenType.SYMBOL || this.tokens[idx + 1]?.value !== ']') break;
            idx += 2;
        }
        // expect identifier (name)
        if (!this.tokens[idx] || this.tokens[idx].type !== TokenType.IDENTIFIER) return false;
        idx++;
        // expect '(' → it's a function
        return this.tokens[idx]?.type === TokenType.SYMBOL && this.tokens[idx].value === '(';
    }

    tryParseFunction(allowModifiers) {
        const checkpoint = this.current;
        try {
            if (allowModifiers) {
                this.skipModifiers();
            }
            const returnType = this.consumeTypeName(true);
            const nameToken = this.consumeIdentifier('Expected function name');
            if (!this.checkSymbol('(')) {
                this.current = checkpoint;
                return null;
            }
            this.consumeSymbol('(', 'Expected ( after function name');
            const parameters = [];
            if (!this.checkSymbol(')')) {
                do {
                    parameters.push(this.parseParameter());
                } while (this.matchSymbol(','));
            }
            this.consumeSymbol(')', 'Expected ) after parameter list');
            const body = this.parseBlock();
            return {
                type: ASTNodeType.FunctionDecl,
                name: nameToken.value,
                returnType: returnType.value,
                parameters,
                body,
                loc: locationFrom(nameToken),
            };
        } catch (error) {
            this.current = checkpoint;
            return null;
        }
    }

    skipUntilSymbol(symbol) {
        while (!this.isAtEnd() && !this.checkSymbol(symbol)) {
            this.advance();
        }
        if (this.matchSymbol(symbol)) {
            return;
        }
    }

    captureError(error) {
        if (!this.errors || !(error instanceof HamsterParserError)) {
            return false;
        }
        if (!this.errors.some(existing => haveSameDiagnostic(existing, error))) {
            this.errors.push(error);
        }
        return true;
    }

    synchronizeStatement(statementStart) {
        while (!this.isAtEnd()) {
            if (this.current > statementStart && this.isStatementStart()) {
                return;
            }
            if (this.checkSymbol('}')) {
                return;
            }
            this.advance();
            if (this.previous().value === ';') {
                return;
            }
        }
    }

    synchronizeTopLevel(declarationStart) {
        while (!this.isAtEnd()) {
            if (this.current > declarationStart && this.isTopLevelStart()) {
                return;
            }
            this.advance();
            if (this.previous().value === ';' || this.previous().value === '}') {
                return;
            }
        }
    }

    isStatementStart() {
        if (this.checkSymbol('{') || this.checkToken(TokenType.IDENTIFIER)) {
            return true;
        }
        if (this.isTypeKeywordAhead()) {
            return true;
        }
        return [
            'if',
            'do',
            'while',
            'for',
            'switch',
            'try',
            'throw',
            'break',
            'return',
        ].some(keyword => this.checkKeyword(keyword));
    }

    isTopLevelStart() {
        return this.isClassLikeDeclarationAhead() ||
            this.isTypeKeywordAhead() ||
            this.isModifierToken(this.peek()) ||
            this.checkKeyword('package') ||
            this.checkKeyword('import');
    }

    consumeIdentifier(message) {
        if (this.checkToken(TokenType.IDENTIFIER)) {
            return this.advance();
        }
        throw new HamsterParserError(message, this.peek());
    }

    consumeSymbol(symbol, message) {
        if (this.matchSymbol(symbol)) {
            return this.previous();
        }
        throw new HamsterParserError(message, this.peek());
    }

    consumeOperator(op, message) {
        if (this.matchOperator(op)) {
            return this.previous();
        }
        throw new HamsterParserError(message, this.peek());
    }

    consumeKeyword(value, message) {
        if (this.matchKeyword(value)) {
            return this.previous();
        }
        throw new HamsterParserError(message, this.peek());
    }

    matchKeyword(value) {
        if (this.checkKeyword(value)) {
            this.advance();
            return true;
        }
        return false;
    }

    matchSymbol(symbol) {
        if (this.checkSymbol(symbol)) {
            this.advance();
            return true;
        }
        return false;
    }

    matchOperator(value) {
        if (this.checkOperator(value)) {
            this.advance();
            return true;
        }
        return false;
    }

    matchToken(type) {
        if (this.checkToken(type)) {
            this.advance();
            return true;
        }
        return false;
    }

    checkKeyword(value) {
        const token = this.peek();
        return token.type === TokenType.KEYWORD && token.value === value;
    }

    checkSymbol(symbol) {
        const token = this.peek();
        return token.type === TokenType.SYMBOL && token.value === symbol;
    }

    checkOperator(value) {
        const token = this.peek();
        return token.type === TokenType.OPERATOR && token.value === value;
    }

    checkToken(type) {
        const token = this.peek();
        return token.type === type;
    }

    peek() {
        return this.tokens[this.current];
    }

    peekNext() {
        if (this.current + 1 >= this.tokens.length) {
            return this.tokens[this.tokens.length - 1];
        }
        return this.tokens[this.current + 1];
    }

    previous() {
        return this.tokens[this.current - 1];
    }

    advance() {
        if (!this.isAtEnd()) {
            this.current += 1;
        }
        return this.previous();
    }

    isAtEnd() {
        return this.peek().type === TokenType.EOF;
    }
}

function makeBinary(operatorToken, left, right) {
    return {
        type: ASTNodeType.BinaryExpression,
        operator: operatorToken.value,
        left,
        right,
        loc: locationFrom(operatorToken),
    };
}

function collectClassMethods(declaration) {
    const methods = [...(declaration.methods || [])];
    for (const nested of declaration.nestedClasses || []) {
        methods.push(...collectClassMethods(nested));
    }
    return methods;
}

function locationFrom(token) {
    return { line: token.line, column: token.column };
}

function isLanguageError(error) {
    return error instanceof HamsterParserError || error instanceof HamsterLexerError;
}

function haveSameDiagnostic(left, right) {
    const leftLocation = left.token || left;
    const rightLocation = right.token || right;
    return left.name === right.name &&
        left.message === right.message &&
        leftLocation.line === rightLocation.line &&
        leftLocation.column === rightLocation.column;
}
