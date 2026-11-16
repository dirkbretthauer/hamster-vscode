import assert from 'node:assert/strict';
import test from 'node:test';
import { collectDiagnostics } from '../lang/hamster-semantics.js';

const messagesFor = source =>
    collectDiagnostics(source, { requireMain: false }).map(error => error.message.replace(/ \(line.*$/, ''));

test('reports unknown functions and variables with a location', () => {
    const errors = collectDiagnostics('void main() {\n  vro();\n  x = 1;\n}', { requireMain: false });
    assert.equal(errors.length, 2);
    assert.match(errors[0].message, /Unknown function 'vro'/);
    assert.equal(errors[0].token.line, 2);
    assert.equal(errors[0].token.length, 3);
    assert.match(errors[1].message, /Unknown variable 'x'/);
});

test('reports wrong argument counts for user functions', () => {
    assert.deepEqual(
        messagesFor('void f(int a, int b) {}\nvoid main() { f(1); }'),
        ["Function 'f' expects 2 argument(s) but got 1"]
    );
});

test('accepts varargs, overloads and hamster builtins', () => {
    assert.deepEqual(messagesFor(`
        void v(int... xs) {}
        void o(int a) {}
        void o(int a, int b) {}
        void main() { v(); v(1, 2, 3); o(1); o(1, 2); vor(); linksUm(); }
    `), []);
});

test('reports trivial literal type mismatches', () => {
    assert.deepEqual(
        messagesFor('void main() { int a = true; boolean b = 1; String s = 5; double d = 1; }'),
        [
            'Type mismatch: cannot convert boolean to int',
            'Type mismatch: cannot convert int to boolean',
            'Type mismatch: cannot convert int to String',
        ]
    );
});

test('reports duplicate classes', () => {
    assert.deepEqual(messagesFor('class A {}\nclass A {}\nvoid main() {}'), ["Duplicate class 'A'"]);
});

test('does not flag fields, enum constants, array length or Object methods', () => {
    assert.deepEqual(messagesFor(`
        enum Color { RED, GREEN }
        class Worker extends Hamster {
            int count;
            void run() { count = count + 1; vor(); wait(); }
        }
        void main() { int[] a = new int[2]; int n = a.length; Color c = Color.RED; }
    `), []);
});

test('skips unknown-name checks when imports may supply names', () => {
    assert.deepEqual(messagesFor('import other.Lib;\nvoid main() { helper(); }'), []);
    assert.deepEqual(messagesFor('void main() { reversi.Regeln.go(); }'), []);
});

test('syntax errors suppress the semantic pass', () => {
    const errors = collectDiagnostics('void main() { int a = ; vro(); }', { requireMain: false });
    assert.equal(errors.length, 1);
    assert.doesNotMatch(errors[0].message, /Unknown function/);
});

test('library members inherited through a class chain or enclosing class are not flagged', () => {
    assert.deepEqual(messagesFor(`
        class A extends Thread {}
        class B extends A { public void run() { start(); } }
        class W extends Thread { class Inner { void f() { start(); sleep(5); } } }
        class Z { void start(int x) {} }
        class V extends Thread { public void run() { start(); } }
        void main() {}
    `), []);
});

test('same-named nested classes in different outer classes are not duplicates', () => {
    assert.deepEqual(messagesFor('class A { class I {} }\nclass B { class I {} }\nvoid main() {}'), []);
});

test('lowercase class qualifiers, package paths and Hamster statics are accepted', () => {
    assert.deepEqual(messagesFor(`
        class util { static int n; }
        class M extends Hamster { void f() { int c = getAnzahlHamster(); } }
        void main() { int a = util.n; Hamster h = new de.hamster.debugger.model.Hamster(); }
    `), []);
});

test('varargs arity message and mismatch underline length', () => {
    assert.deepEqual(
        messagesFor('void v(int a, int... xs) {}\nvoid main() { v(); }'),
        ["Function 'v' expects at least 1 argument(s) but got 0"]
    );
    const [error] = collectDiagnostics('void main() { int a = "hello"; }', { requireMain: false });
    assert.equal(error.token.length, '"hello"'.length);
});
