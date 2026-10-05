# Contract: Grammar Additions and AST Node Shapes

Consumers: `lang/hamster-runner.js`, `collectExecutableLines`, `src/diagnostics.ts` (error shape only), the
debugger's expression evaluator. Grammar notation is EBNF-like; terminals are quoted.

## Grammar additions

```ebnf
Modifier          ::= … | "synchronized"

TypeArguments     ::= "<" [ TypeArgument { "," TypeArgument } ] ">"       (* empty = diamond, only after new *)
TypeArgument      ::= Type | "?" [ ("extends" | "super") Type ]
Type              ::= ( "int" | "boolean" | QualifiedName [ TypeArguments ] ) { "[" "]" }
TypeParameters    ::= "<" TypeParameter { "," TypeParameter } ">"
TypeParameter     ::= Identifier [ "extends" Type ]

ClassDecl         ::= Modifiers ("class" | "interface") Identifier [ TypeParameters ]
                      [ "extends" TypeList ] [ "implements" TypeList ] ClassBody
MethodDecl        ::= Modifiers [ TypeParameters ] ( Type | "void" ) Identifier Parameters [ Throws ] ( Block | ";" )

Statement         ::= … | "synchronized" "(" Expression ")" Block
TryStatement      ::= "try" Block ( CatchClause { CatchClause } [ "finally" Block ] | "finally" Block )
CatchClause       ::= "catch" "(" { Modifier } Type Identifier ")" Block

Relational        ::= Additive { ( "<" | ">" | "<=" | ">=" ) Additive | "instanceof" ReferenceType }

VariableInit      ::= Expression | ArrayInitializer
ArrayInitializer  ::= "{" [ VariableInit { "," VariableInit } [ "," ] ] "}"
NewExpression     ::= "new" ( "int" | "boolean" | QualifiedName [ TypeArguments ] )
                      ( Arguments | DimExprs { "[" "]" } | "[" "]" { "[" "]" } ArrayInitializer )
```

`Type` appears in declarations, parameters, return types, casts, `catch`, `extends`/`implements`/`throws`, and
`new`. Type arguments are recognised **only** in those positions (research D1).

## Node shapes

```js
// try { … } catch (A a) { … } catch (B b) { … } finally { … }
{ type: 'TryStatement', block: Block, handlers: CatchClause[], finalizer: Block | null, loc }
{ type: 'CatchClause', paramType: 'A', paramName: 'a', body: Block, loc }

// synchronized (lock) { … }
{ type: 'SynchronizedStatement', lock: Expression, body: Block, loc }

// x instanceof pkg.Foo[]
{ type: 'InstanceofExpression', argument: Expression, targetType: 'pkg.Foo', arrayDimensions: 1, loc }

// { 1, { 2, 3 } }
{ type: 'ArrayInitializer', elements: [Literal, ArrayInitializer], loc }

// new int[] { 1, 2 }
{ type: 'NewExpression', callee: Identifier('int'), arguments: [], dimensions: [null],
  initializer: ArrayInitializer, loc }

// class Pair<K, V extends Hamster> / <T> void f()
{ type: 'ClassDeclaration', name: 'Pair', typeParameters: ['K', 'V'], … }
{ type: 'FunctionDeclaration', name: 'f', typeParameters: ['T'], … }
```

Erasure: `Speicher<Integer> k` → `VariableDeclaration.varType === 'Speicher'`;
`implements Callable<Integer>` → `interfaces: ['Callable']`; `new Pair<K, V>(…)` → `callee: Identifier('Pair')`.

## Error shape

```js
HamsterParserError { name, message, token: { line, column, length }, unsupportedConstruct?: string }
HamsterLexerError  { name, message, line, column, length,           unsupportedConstruct?: string }
```

`unsupportedConstruct` is one of the six codes in [data-model.md](../data-model.md#parser-error-metadata-known-gaps).
Diagnostics ignore it. Only the conformance check reads it.
