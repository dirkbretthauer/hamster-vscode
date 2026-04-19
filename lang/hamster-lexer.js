/**
 * Hamster Imperative Language lexer.
 *
 * Converts legacy `.ham` source text into a flat token stream while tracking
 * line/column metadata required by the parser and diagnostics.
 */

const KEYWORDS = new Set([
    'void',
    'int',
    'boolean',
    'do',
    'for',
    'while',
    'if',
    'else',
    'return',
    'new',
    'null',
    'class',
    'interface',
    'public',
    'private',
    'protected',
    'static',
    'final',
    'package',
    'import',
    'extends',
    'implements',
    'this',
]);

const SINGLE_CHAR_TOKENS = new Map([
    ['(', 'LPAREN'],
    [')', 'RPAREN'],
    ['{', 'LBRACE'],
    ['}', 'RBRACE'],
    ['[', 'LBRACKET'],
    [']', 'RBRACKET'],
    ['.', 'DOT'],
    ['?', 'QUESTION'],
    [':', 'COLON'],
    [',', 'COMMA'],
    [';', 'SEMICOLON'],
]);

const MULTI_CHAR_OPERATORS = new Map([
    ['==', 'EQ'],
    ['!=', 'NEQ'],
    ['<=', 'LTE'],
    ['>=', 'GTE'],
    ['&&', 'AND'],
    ['||', 'OR'],
    ['++', 'INC'],
    ['--', 'DEC'],
]);

const SINGLE_CHAR_OPERATORS = new Map([
    ['+', 'PLUS'],
    ['-', 'MINUS'],
    ['*', 'STAR'],
    ['/', 'SLASH'],
    ['%', 'MOD'],
    ['<', 'LT'],
    ['>', 'GT'],
    ['=', 'ASSIGN'],
    ['!', 'BANG'],
]);

export const TokenType = Object.freeze({
    EOF: 'EOF',
    IDENTIFIER: 'IDENTIFIER',
    INTEGER: 'INTEGER',
    STRING: 'STRING',
    BOOLEAN: 'BOOLEAN',
    NULL: 'NULL',
    KEYWORD: 'KEYWORD',
    SYMBOL: 'SYMBOL',
    OPERATOR: 'OPERATOR',
});

export class Token {
    constructor(type, value, line, column) {
        this.type = type;
        this.value = value;
        this.line = line;
        this.column = column;
    }
}

export class HamsterLexerError extends Error {
    constructor(message, line, column) {
        super(`Line ${line}, column ${column}: ${message}`);
        this.name = 'HamsterLexerError';
        this.line = line;
        this.column = column;
    }
}

export class HamsterLexer {
    constructor(source) {
        this.source = source ?? '';
        this.length = this.source.length;
        this.index = 0;
        this.line = 1;
        this.column = 1;
    }

    tokenize() {
        const tokens = [];
        while (true) {
            this.skipTrivia();
            if (this.isAtEnd()) {
                tokens.push(new Token(TokenType.EOF, null, this.line, this.column));
                break;
            }
            const token = this.scanToken();
            if (token) tokens.push(token);
        }
        return tokens;
    }

    scanToken() {
        const startLine = this.line;
        const startColumn = this.column;
        const ch = this.advance();

        if (isDigit(ch)) {
            const value = this.readNumber(ch);
            return new Token(TokenType.INTEGER, value, startLine, startColumn);
        }

        if (isIdentifierStart(ch)) {
            const text = this.readIdentifier(ch);
            if (text === 'true' || text === 'false') {
                return new Token(TokenType.BOOLEAN, text === 'true', startLine, startColumn);
            }
            if (text === 'null') {
                return new Token(TokenType.NULL, null, startLine, startColumn);
            }
            if (KEYWORDS.has(text)) {
                return new Token(TokenType.KEYWORD, text, startLine, startColumn);
            }
            return new Token(TokenType.IDENTIFIER, text, startLine, startColumn);
        }

        if (ch === '"') {
            return this.readString(startLine, startColumn);
        }

        const maybeTwoChar = ch + this.peek();
        if (MULTI_CHAR_OPERATORS.has(maybeTwoChar)) {
            this.advance();
            return new Token(TokenType.OPERATOR, maybeTwoChar, startLine, startColumn);
        }

        if (SINGLE_CHAR_TOKENS.has(ch)) {
            return new Token(TokenType.SYMBOL, ch, startLine, startColumn);
        }

        if (SINGLE_CHAR_OPERATORS.has(ch)) {
            return new Token(TokenType.OPERATOR, ch, startLine, startColumn);
        }

        throw new HamsterLexerError(`Unexpected character '${ch}'`, startLine, startColumn);
    }

    readNumber(initialChar) {
        let value = initialChar;
        while (isDigit(this.peek())) {
            value += this.advance();
        }
        return value;
    }

    readIdentifier(initialChar) {
        let value = initialChar;
        while (isIdentifierPart(this.peek())) {
            value += this.advance();
        }
        return value;
    }

    readString(startLine, startColumn) {
        let value = '';
        while (!this.isAtEnd()) {
            const ch = this.advance();
            if (ch === '"') {
                return new Token(TokenType.STRING, value, startLine, startColumn);
            }
            if (ch === '\\') {
                const escaped = this.advance();
                switch (escaped) {
                    case 'n': value += '\n'; break;
                    case 'r': value += '\r'; break;
                    case 't': value += '\t'; break;
                    case '"': value += '"'; break;
                    case '\\': value += '\\'; break;
                    default: value += escaped; break;
                }
                continue;
            }
            value += ch;
        }
        throw new HamsterLexerError('Unterminated string literal', startLine, startColumn);
    }

    skipTrivia() {
        while (!this.isAtEnd()) {
            const ch = this.peek();
            if (isWhitespace(ch)) {
                this.advance();
                continue;
            }
            if (ch === '/' && this.peekNext() === '/') {
                this.skipLineComment();
                continue;
            }
            if (ch === '/' && this.peekNext() === '*') {
                this.skipBlockComment();
                continue;
            }
            break;
        }
    }

    skipLineComment() {
        while (!this.isAtEnd() && this.peek() !== '\n') {
            this.advance();
        }
        if (!this.isAtEnd()) {
            this.advance();
        }
    }

    skipBlockComment() {
        // consume the initial "/*"
        this.advance();
        this.advance();
        while (!this.isAtEnd()) {
            if (this.peek() === '*' && this.peekNext() === '/') {
                this.advance();
                this.advance();
                return;
            }
            this.advance();
        }
        throw new HamsterLexerError('Unterminated block comment', this.line, this.column);
    }

    advance() {
        const ch = this.source[this.index++];
        if (ch === '\n') {
            this.line += 1;
            this.column = 1;
        } else {
            this.column += 1;
        }
        return ch;
    }

    peek() {
        if (this.isAtEnd()) return '\0';
        return this.source[this.index];
    }

    peekNext() {
        if (this.index + 1 >= this.length) return '\0';
        return this.source[this.index + 1];
    }

    isAtEnd() {
        return this.index >= this.length;
    }
}

function isWhitespace(ch) {
    return ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n';
}

function isDigit(ch) {
    return ch >= '0' && ch <= '9';
}

function isIdentifierStart(ch) {
    return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
}

function isIdentifierPart(ch) {
    return isIdentifierStart(ch) || isDigit(ch);
}
