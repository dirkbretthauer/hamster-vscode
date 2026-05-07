import { HamsterLexer, TokenType } from './hamster-lexer.js';

export const ASTNodeType = Object.freeze({
    Program: 'Program',
    FunctionDecl: 'FunctionDeclaration',
    Parameter: 'Parameter',
    Block: 'BlockStatement',
    VariableDecl: 'VariableDeclaration',
    Assignment: 'AssignmentStatement',
    ExpressionStmt: 'ExpressionStatement',
    IfStatement: 'IfStatement',
    WhileStatement: 'WhileStatement',
    DoWhileStatement: 'DoWhileStatement',
    ForStatement: 'ForStatement',
    ReturnStatement: 'ReturnStatement',
    ConditionalExpression: 'ConditionalExpression',
    BinaryExpression: 'BinaryExpression',
    UnaryExpression: 'UnaryExpression',
    PostfixExpression: 'PostfixExpression',
    Literal: 'Literal',
    Identifier: 'Identifier',
    CallExpression: 'CallExpression',
    MemberExpression: 'MemberExpression',
    IndexExpression: 'IndexExpression',
    NewExpression: 'NewExpression',
    ThisExpression: 'ThisExpression',
});

export class HamsterParserError extends Error {
    constructor(message, token) {
        const location = token ? ` (line ${token.line}, column ${token.column})` : '';
        super(message + location);
        this.name = 'HamsterParserError';
        this.token = token;
    }
}

export function parseProgram(source, options = {}) {
    const parser = new Parser(source, options);
    return parser.parseProgram();
}

class Parser {
    constructor(source, options = {}) {
        this.tokens = new HamsterLexer(source).tokenize();
        this.current = 0;
        this.options = {
            requireMain: options.requireMain !== undefined ? options.requireMain : true,
            compatibility: options.compatibility === true,
        };
    }

    parseProgram() {
        if (this.options.compatibility) {
            return this.parseCompatibilityProgram();
        }
        if (this.isAtEnd()) {
            throw new HamsterParserError('Program must define void main()', this.peek());
        }
        const functions = [];
        const globals = [];
        // Parse global variable declarations before main()
        while (!this.isAtEnd() && this.isTypeKeywordAhead() && !this.isFunctionAhead()) {
            globals.push(this.parseVariableDeclaration());
        }
        functions.push(this.parseFunction(true));
        while (!this.isAtEnd()) {
            functions.push(this.parseFunction(false));
        }
        return { type: ASTNodeType.Program, functions, globals };
    }

    parseCompatibilityProgram() {
        const functions = [];
        const globals = [];
        while (!this.isAtEnd()) {
            if (this.checkKeyword('package') || this.checkKeyword('import')) {
                this.skipUntilSymbol(';');
                continue;
            }
            if (this.checkKeyword('class') || this.checkKeyword('interface')) {
                functions.push(...this.parseCompatibilityClassLikeDeclaration());
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
            this.advance();
        }
        if (this.options.requireMain && !functions.some(fn => fn.name === 'main' && fn.returnType === 'void')) {
            throw new HamsterParserError('Program must define void main()', this.peek());
        }
        return { type: ASTNodeType.Program, functions, globals };
    }

    parseCompatibilityClassLikeDeclaration() {
        const functions = [];

        // consume class/interface keyword and declaration header
        this.advance();
        while (!this.isAtEnd() && !this.checkSymbol('{') && !this.checkSymbol(';')) {
            this.advance();
        }
        if (this.matchSymbol(';')) {
            return functions;
        }
        if (!this.matchSymbol('{')) {
            return functions;
        }

        let depth = 1;
        while (!this.isAtEnd() && depth > 0) {
            if (depth === 1) {
                const fn = this.tryParseFunction(true);
                if (fn) {
                    functions.push(fn);
                    continue;
                }
            }

            if (this.matchSymbol('{')) {
                depth += 1;
                continue;
            }
            if (this.matchSymbol('}')) {
                depth -= 1;
                continue;
            }
            this.advance();
        }

        return functions;
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
            statements.push(this.parseStatement());
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
        const body = this.parseStatement();
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
        const body = this.parseStatement();
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

        const body = this.parseStatement();
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
        this.consumeOperator('=', 'Expected = in assignment');
        const value = this.parseExpression();
        return {
            type: ASTNodeType.Assignment,
            name: target.type === ASTNodeType.Identifier ? target.name : null,
            target,
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
        this.consumeOperator('=', 'Expected = in assignment');
        const value = this.parseExpression();
        this.consumeSymbol(';', 'Expected ; after assignment');
        return {
            type: ASTNodeType.Assignment,
            name: target.type === ASTNodeType.Identifier ? target.name : null,
            target,
            value,
            loc: target.loc,
        };
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
            expr = {
                type: ASTNodeType.PostfixExpression,
                operator: operator.value,
                argument: expr,
                loc: locationFrom(operator),
            };
        }
        return expr;
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
        if (!this.checkToken(TokenType.IDENTIFIER) && !this.checkKeyword('this')) return false;
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
            return token.type === TokenType.OPERATOR && token.value === '=';
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
        while (this.checkKeyword('public') || this.checkKeyword('private') || this.checkKeyword('protected') ||
               this.checkKeyword('static') || this.checkKeyword('final')) {
            this.advance();
        }
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
                t.value === 'protected' || t.value === 'static' || t.value === 'final')) {
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

    skipClassLikeDeclaration() {
        this.advance();
        while (!this.isAtEnd() && !this.checkSymbol('{') && !this.checkSymbol(';')) {
            this.advance();
        }
        if (this.matchSymbol(';')) {
            return;
        }
        if (!this.matchSymbol('{')) {
            return;
        }
        let depth = 1;
        while (!this.isAtEnd() && depth > 0) {
            if (this.matchSymbol('{')) {
                depth += 1;
                continue;
            }
            if (this.matchSymbol('}')) {
                depth -= 1;
                continue;
            }
            this.advance();
        }
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

function locationFrom(token) {
    return { line: token.line, column: token.column };
}
