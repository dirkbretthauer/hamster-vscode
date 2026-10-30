/**
 * Hamster runtime adapter: bridges the generic OO-method-call interface the
 * language runner expects (`resolveIdentifier`/`createObject`/`getMember`/
 * `setMember`/`callMethod`/`callBuiltin`) to the simulator engine's
 * `vor`/`nimm`/... built-in API, plus the `Territorium`/`Territory` static
 * helpers and terminal I/O glue. Moved out of `hamsterPanel.ts`'s inline
 * script unchanged in behavior.
 */
import { isWallAt, insideTerrain, findHamster } from '../shared/terrainEngineState.js';
import { hamsterError } from './engine.js';
import {
    CALENDAR_CONSTANTS, TIME_METHOD_NOT_HANDLED,
    isDateClassName, isCalendarClassName, createJavaDate, createJavaCalendar,
    callJavaDateMethod, callJavaCalendarMethod,
} from './javaTime.js';

const TIMER_CLASS_NAMES = new Set(['Timer', 'java.util.Timer']);
/** Top-level package names that may start a fully qualified class name such as `java.util.Calendar`. */
const JAVA_PACKAGE_ROOTS = new Set(['java', 'javax']);
const TIMER_TASK_CLASS_NAMES = new Set(['TimerTask', 'java.util.TimerTask']);
const SEMAPHORE_CLASS_NAMES = new Set(['Semaphore', 'java.util.concurrent.Semaphore']);
const REENTRANT_LOCK_CLASS_NAMES = new Set([
    'ReentrantLock', 'java.util.concurrent.locks.ReentrantLock',
]);
const ATOMIC_BOOLEAN_CLASS_NAMES = new Set([
    'AtomicBoolean', 'java.util.concurrent.atomic.AtomicBoolean',
]);

function concurrentClassNames(simpleName) {
    return new Set([simpleName, 'java.util.concurrent.' + simpleName]);
}

const COUNT_DOWN_LATCH_CLASS_NAMES = concurrentClassNames('CountDownLatch');
const CYCLIC_BARRIER_CLASS_NAMES = concurrentClassNames('CyclicBarrier');
const EXCHANGER_CLASS_NAMES = concurrentClassNames('Exchanger');
const ARRAY_BLOCKING_QUEUE_CLASS_NAMES = concurrentClassNames('ArrayBlockingQueue');
const LINKED_BLOCKING_QUEUE_CLASS_NAMES = concurrentClassNames('LinkedBlockingQueue');
const SYNCHRONOUS_QUEUE_CLASS_NAMES = concurrentClassNames('SynchronousQueue');

function concurrentObject(className, properties = {}) {
    return { __kind: 'object', className, ...properties, fields: Object.create(null) };
}

function requireIntegerArgument(value, isValid, typeName, message) {
    const number = Number(value);
    if (!Number.isInteger(number) || !isValid(number)) throw javaRuntimeException(typeName, message);
    return number;
}

function createJavaCountDownLatch(className, args) {
    if (args.length !== 1) throw new Error('CountDownLatch constructor expects one count argument');
    const count = requireIntegerArgument(args[0], value => value >= 0,
        'IllegalArgumentException', 'count < 0');
    return concurrentObject(className, { initialCount: count });
}

function createJavaCyclicBarrier(className, args) {
    if (args.length < 1 || args.length > 2) {
        throw new Error('CyclicBarrier constructor expects parties and an optional barrier action');
    }
    const parties = requireIntegerArgument(args[0], value => value > 0,
        'IllegalArgumentException', 'parties must be positive');
    return concurrentObject(className, { parties, barrierAction: args[1] ?? null });
}

function createJavaExchanger(className, args) {
    if (args.length !== 0) throw new Error('Exchanger constructor expects no arguments');
    return concurrentObject(className);
}

/**
 * `new ArrayBlockingQueue(capacity[, fair])`, `new LinkedBlockingQueue([capacity])`,
 * and `new SynchronousQueue([fair])`, which has no capacity at all.
 */
function createJavaBlockingQueue(className, args) {
    if (SYNCHRONOUS_QUEUE_CLASS_NAMES.has(className)) {
        if (args.length > 1) throw new Error('SynchronousQueue constructor expects at most one fairness flag');
        return concurrentObject(className, { capacity: 0 });
    }
    const isArrayQueue = ARRAY_BLOCKING_QUEUE_CLASS_NAMES.has(className);
    const maxArgs = isArrayQueue ? 2 : 1;
    if (args.length > maxArgs || (isArrayQueue && args.length === 0)) {
        throw new Error(isArrayQueue
            ? 'ArrayBlockingQueue constructor expects a capacity and an optional fairness flag'
            : 'LinkedBlockingQueue constructor expects at most one capacity argument');
    }
    const capacity = args.length === 0
        ? Infinity
        : requireIntegerArgument(args[0], value => value > 0,
            'IllegalArgumentException', 'capacity must be positive');
    return concurrentObject(className, { capacity });
}

function isBlockingQueueClassName(className) {
    return ARRAY_BLOCKING_QUEUE_CLASS_NAMES.has(className) ||
        LINKED_BLOCKING_QUEUE_CLASS_NAMES.has(className) ||
        SYNCHRONOUS_QUEUE_CLASS_NAMES.has(className);
}

function simpleClassName(name) {
    return name.slice(name.lastIndexOf('.') + 1);
}

/** `new Timer()`, `new Timer(isDaemon)`, `new Timer(name)` and `new Timer(name, isDaemon)`. */
function createJavaTimer(args) {
    if (args.length > 2) throw new Error('Timer constructor expects at most two arguments');
    const [first, second] = args;
    const name = typeof first === 'string' ? first : null;
    const isDaemon = Boolean(typeof first === 'boolean' ? first : second);
    return { __kind: 'object', className: 'Timer', timerName: name, isDaemon, fields: Object.create(null) };
}

function createJavaSemaphore(className, args) {
    if (args.length < 1 || args.length > 2) {
        throw new Error('Semaphore constructor expects permits and an optional fairness flag');
    }
    const permits = Number(args[0]);
    if (!Number.isInteger(permits) || permits < 0) {
        throw javaRuntimeException('IllegalArgumentException', 'Semaphore permits must be non-negative');
    }
    return {
        __kind: 'object',
        className,
        initialPermits: permits,
        fair: Boolean(args[1]),
        fields: Object.create(null),
    };
}

function createJavaReentrantLock(className, args) {
    if (args.length > 1) throw new Error('ReentrantLock constructor expects at most one fairness flag');
    return { __kind: 'object', className, fair: Boolean(args[0]), fields: Object.create(null) };
}

function createJavaAtomicBoolean(className, args) {
    if (args.length > 1) throw new Error('AtomicBoolean constructor expects at most one initial value');
    return { __kind: 'object', className, value: Boolean(args[0]), fields: Object.create(null) };
}

function callAtomicBooleanMethod(receiver, methodName, args) {
    switch (methodName) {
        case 'get':
            if (args.length !== 0) throw new Error('AtomicBoolean.get expects no arguments');
            return receiver.value;
        case 'set':
        case 'lazySet':
            if (args.length !== 1) throw new Error('AtomicBoolean.' + methodName + ' expects one argument');
            receiver.value = Boolean(args[0]);
            return undefined;
        case 'compareAndSet':
            if (args.length !== 2) throw new Error('AtomicBoolean.compareAndSet expects two arguments');
            if (receiver.value !== Boolean(args[0])) return false;
            receiver.value = Boolean(args[1]);
            return true;
        case 'getAndSet': {
            if (args.length !== 1) throw new Error('AtomicBoolean.getAndSet expects one argument');
            const previous = receiver.value;
            receiver.value = Boolean(args[0]);
            return previous;
        }
        default:
            return null;
    }
}

/** Aliases accepted by both the German and English Hamster APIs, normalized to the German canonical name. */
const hamsterMethodAliases = Object.freeze({
    move: 'vor',
    turnLeft: 'linksUm',
    pickGrain: 'nimm',
    putGrain: 'gib',
    frontIsClear: 'vornFrei',
    grainAvailable: 'kornDa',
    mouthEmpty: 'maulLeer',
    getRow: 'getReihe',
    getColumn: 'getSpalte',
    getDirection: 'getBlickrichtung',
    getNumberOfGrains: 'getAnzahlKoerner',
    write: 'schreib',
    readNumber: 'liesZahl',
    readInt: 'liesZahl',
    readString: 'liesZeichenkette',
    liesString: 'liesZeichenkette',
});

function normalizeHamsterMethodName(name) {
    return hamsterMethodAliases[name] || name;
}

/** Sentinel returned by `callHamsterInstanceMethod` when `methodName` isn't a known built-in. */
const HAMSTER_METHOD_NOT_HANDLED = Symbol('hamsterMethodNotHandled');
const RANDOM_METHOD_NOT_HANDLED = Symbol('randomMethodNotHandled');
const JAVA_RANDOM_MULTIPLIER = 0x5DEECE66Dn;
const JAVA_RANDOM_ADDEND = 0xBn;
const JAVA_RANDOM_MASK = (1n << 48n) - 1n;

/** Runtime-created placeholder objects stand in for Java library classes the simulator doesn't provide. */
function unprovidedClassError(className, methodName) {
    return new Error(`${className}.${methodName}: class ${className} is not provided by the Hamster simulator`);
}

/** An error the runner turns into a catchable Java exception of `typeName` (see `normalizeBuiltinFailure`). */
function javaRuntimeException(typeName, message) {
    const error = new Error(message);
    error.name = typeName;
    error.hamsterExceptionType = typeName;
    return error;
}

function defaultHamsterId(args) {
    if (!args || args.length === 0) return -1;
    const first = args[0];
    if (first && typeof first === 'object' && first.__kind === 'hamster') return Number(first.id);
    return Number(first);
}

function createJavaRandom(seed) {
    let numericSeed = Number(seed);
    if (!Number.isFinite(numericSeed) || !Number.isInteger(numericSeed)) {
        throw new Error('Random constructor seed must be an integer');
    }
    let state = (BigInt(numericSeed) ^ JAVA_RANDOM_MULTIPLIER) & JAVA_RANDOM_MASK;
    return {
        __kind: 'object',
        className: 'Random',
        fields: Object.create(null),
        nextRandomBits(bitCount) {
            state = (state * JAVA_RANDOM_MULTIPLIER + JAVA_RANDOM_ADDEND) & JAVA_RANDOM_MASK;
            return Number(state >> BigInt(48 - bitCount));
        },
    };
}

function callJavaRandomMethod(receiver, methodName, args) {
    if (methodName !== 'nextInt') return RANDOM_METHOD_NOT_HANDLED;
    if (args.length !== 1) throw new Error('Random.nextInt expects exactly one bound');

    const bound = Number(args[0]);
    if (!Number.isInteger(bound) || bound <= 0 || bound > 0x7fffffff) {
        throw javaRuntimeException('IllegalArgumentException', 'bound must be positive');
    }

    if ((bound & -bound) === bound) {
        return Number((BigInt(bound) * BigInt(receiver.nextRandomBits(31))) >> 31n);
    }

    let bits;
    let value;
    do {
        bits = receiver.nextRandomBits(31);
        value = bits % bound;
    } while (((bits - value + (bound - 1)) | 0) < 0);
    return value;
}

function collectionClassType(className) {
    switch (className.slice(className.lastIndexOf('.') + 1)) {
        case 'ArrayList':
        case 'Vector': return 'list';
        case 'Stack': return 'stack';
        case 'LinkedList': return 'queue';
        case 'HashSet': return 'set';
        case 'HashMap': return 'map';
        default: return null;
    }
}

function requireCollectionArguments(className, methodName, args, expectedCount) {
    if (args.length !== expectedCount) {
        throw new Error(`${className}.${methodName} expects ${expectedCount} argument${expectedCount === 1 ? '' : 's'}`);
    }
}

function collectionError(receiver, methodName) {
    return new Error(`${receiver.className}.${methodName}: unsupported collection method`);
}

function collectionKeyIndex(entries, key) {
    return entries.findIndex(entry => Object.is(entry.key, key));
}

/** Vector and its Stack subclass use `ArrayIndexOutOfBoundsException` for bad indices. */
function indexOutOfBoundsTypeFor(className) {
    return ['Vector', 'Stack'].includes(className.slice(className.lastIndexOf('.') + 1))
        ? 'ArrayIndexOutOfBoundsException'
        : 'IndexOutOfBoundsException';
}

function requireCollectionIndex(receiver, index, isEndAllowed) {
    const limit = isEndAllowed ? receiver.values.length : receiver.values.length - 1;
    if (Number.isInteger(index) && index >= 0 && index <= limit) return;
    throw javaRuntimeException(
        indexOutOfBoundsTypeFor(receiver.className),
        `Index ${index} out of bounds for length ${receiver.values.length}`
    );
}

/**
 * Index-free `remove`/`indexOf`/`contains` on lists. The runner answers these
 * itself with Java `equals` semantics; this identity-based version only serves
 * callers that use the runtime directly.
 */
function callListValueMethod(values, methodName, value) {
    const index = values.findIndex(candidate => Object.is(candidate, value));
    if (methodName === 'indexOf') return index;
    if (methodName === 'contains') return index >= 0;
    if (index < 0) return false;
    values.splice(index, 1);
    return true;
}

function isListValueMethod(methodName, args) {
    if (args.length !== 1) return false;
    if (methodName === 'indexOf' || methodName === 'contains') return true;
    return methodName === 'remove' && typeof args[0] !== 'number';
}

function callStackMethod(receiver, methodName, args) {
    const values = receiver.values;
    const hasArgument = methodName === 'push' || methodName === 'search';
    requireCollectionArguments(receiver.className, methodName, args, hasArgument ? 1 : 0);
    if (methodName === 'push') {
        values.push(args[0]);
        return args[0];
    }
    if (methodName === 'empty') return values.length === 0;
    if (methodName === 'search') {
        for (let index = values.length - 1; index >= 0; index--) {
            if (Object.is(values[index], args[0])) return values.length - index;
        }
        return -1;
    }
    if (values.length === 0) {
        throw javaRuntimeException('EmptyStackException', 'Stack is empty');
    }
    return methodName === 'pop' ? values.pop() : values[values.length - 1];
}

function callCollectionMethod(receiver, methodName, args) {
    const values = receiver.values;
    const entries = receiver.entries;
    const className = receiver.className;

    if (receiver.__kind === 'collectionIterator') {
        requireCollectionArguments(className, methodName, args, 0);
        if (methodName === 'hasNext') return receiver.index < values.length;
        if (methodName === 'next') {
            if (receiver.index >= values.length) {
                throw javaRuntimeException('NoSuchElementException', 'Iterator has no more elements');
            }
            return values[receiver.index++];
        }
        throw collectionError(receiver, methodName);
    }

    if (receiver.collectionType === 'stack' &&
        ['push', 'pop', 'peek', 'empty', 'search'].includes(methodName)) {
        return callStackMethod(receiver, methodName, args);
    }

    if (methodName === 'size' || methodName === 'isEmpty' || methodName === 'clear' ||
        methodName === 'iterator') {
        requireCollectionArguments(className, methodName, args, 0);
        if (methodName === 'size') return receiver.collectionType === 'map' ? entries.length : values.length;
        if (methodName === 'isEmpty') return receiver.collectionType === 'map' ? entries.length === 0 : values.length === 0;
        if (methodName === 'clear') {
            if (receiver.collectionType === 'map') entries.length = 0;
            else values.length = 0;
            return undefined;
        }
        if (receiver.collectionType === 'map') throw collectionError(receiver, methodName);
        return { __kind: 'collectionIterator', className: 'Iterator', values: [...values], index: 0 };
    }

    switch (receiver.collectionType) {
        case 'list':
        case 'stack':
        case 'queue':
            if ((methodName === 'add' || (receiver.collectionType === 'queue' && methodName === 'offer')) &&
                args.length === 1) {
                values.push(args[0]);
                return true;
            }
            if (receiver.collectionType !== 'queue' && methodName === 'add' && args.length === 2) {
                const [index, value] = args;
                requireCollectionIndex(receiver, index, true);
                values.splice(index, 0, value);
                return undefined;
            }
            if (receiver.collectionType === 'queue' && args.length === 0) {
                if (methodName === 'poll') return values.shift() ?? null;
                if (methodName === 'peek') return values[0] ?? null;
            }
            if (isListValueMethod(methodName, args)) {
                return callListValueMethod(values, methodName, args[0]);
            }
            if (methodName === 'get' && args.length === 1) {
                requireCollectionIndex(receiver, args[0], false);
                return values[args[0]];
            }
            if (methodName === 'remove' && args.length === 1) {
                requireCollectionIndex(receiver, args[0], false);
                return values.splice(args[0], 1)[0];
            }
            break;
        case 'set':
            if (methodName === 'add' && args.length === 1) {
                if (values.some(value => Object.is(value, args[0]))) return false;
                values.push(args[0]);
                return true;
            }
            if ((methodName === 'contains' || methodName === 'remove') && args.length === 1) {
                const index = values.findIndex(value => Object.is(value, args[0]));
                if (methodName === 'contains') return index >= 0;
                return index < 0 ? false : (values.splice(index, 1), true);
            }
            break;
        case 'map':
            if (methodName === 'put' && args.length === 2) {
                const [key, value] = args;
                const index = collectionKeyIndex(entries, key);
                if (index >= 0) {
                    const previous = entries[index].value;
                    entries[index].value = value;
                    return previous;
                }
                entries.push({ key, value });
                return null;
            }
            if (methodName === 'get' && args.length === 1) {
                const index = collectionKeyIndex(entries, args[0]);
                return index >= 0 ? entries[index].value : null;
            }
            if (methodName === 'containsKey' && args.length === 1) {
                return collectionKeyIndex(entries, args[0]) >= 0;
            }
            if (methodName === 'remove' && args.length === 1) {
                const index = collectionKeyIndex(entries, args[0]);
                return index < 0 ? null : entries.splice(index, 1)[0].value;
            }
            break;
    }
    throw collectionError(receiver, methodName);
}

/**
 * @param {object} deps
 * @param {object} deps.engine the simulator engine's built-in API (vor/nimm/...)
 * @param {() => object} deps.getEngineState live (non-cloned) engine state
 * @param {(text: string) => void} deps.appendLog writes a line to the on-screen log
 * @param {(kind: 'number'|'string', hamsterId: number, prompt: string) => (number|string)} deps.readTerminalValue
 */
export function createHamsterRuntime({ engine, getEngineState, appendLog, readTerminalValue, currentTimeMillis }) {
    const wallClock = typeof currentTimeMillis === 'function' ? currentTimeMillis : () => Date.now();
    let clock = wallClock;

    function createCalendarFromArgs(args) {
        const calendar = createJavaCalendar(clock());
        if (args.length === 0) return calendar;
        // Java's field constructors start from midnight, not from "now".
        const midnight = new Date(calendar.__epochMillis);
        midnight.setHours(0, 0, 0, 0);
        calendar.__epochMillis = midnight.getTime();
        callJavaCalendarMethod(calendar, 'set', args);
        return calendar;
    }

    function territoryHamsters(args) {
        let hamsters = getEngineState().terrain.hamsters;
        if (args.length >= 2) {
            const row = Number(args[0]), col = Number(args[1]);
            hamsters = hamsters.filter(h => h.y === row && h.x === col);
        }
        return hamsters.map(h => ({ __kind: 'hamster', id: h.id, className: 'Hamster' }));
    }

    function callTerritoryBuiltin(methodName, args) {
        const terrain = getEngineState().terrain;
        switch (methodName) {
            case 'getAnzahlReihen':
            case 'getNumberOfRows': return terrain.height;
            case 'getAnzahlSpalten':
            case 'getNumberOfColumns': return terrain.width;
            case 'mauerDa':
            case 'wall': return isWallAt(terrain, Number(args[1]), Number(args[0]));
            case 'getAnzahlKoerner':
            case 'getNumberOfGrains':
                if (args.length >= 2) {
                    const row = Number(args[0]), col = Number(args[1]);
                    return insideTerrain(terrain, col, row) ? terrain.corn[row][col] : 0;
                }
                return terrain.corn.reduce(
                    (total, row) => total + row.reduce((sum, count) => sum + count, 0), 0
                );
            case 'getAnzahlHamster':
            case 'getNumberOfHamsters': return territoryHamsters(args).length;
            case 'getHamster': return territoryHamsters(args);
            default: throw new Error('Unknown territory function: ' + methodName);
        }
    }

    function callHamsterInstanceMethod(hid, methodName, args) {
        switch (methodName) {
            case 'vor': return engine.vor(hid);
            case 'linksUm': return engine.linksUm(hid);
            case 'rechtsUm': engine.linksUm(hid); engine.linksUm(hid); return engine.linksUm(hid);
            case 'nimm': return engine.nimm(hid);
            case 'gib': return engine.gib(hid);
            case 'vornFrei': return engine.vornFrei(hid);
            case 'kornDa': return engine.kornDa(hid);
            case 'maulLeer': return engine.maulLeer(hid);
            case 'getReihe': return engine.getReihe(hid);
            case 'getSpalte': return engine.getSpalte(hid);
            case 'getBlickrichtung': return engine.getBlickrichtung(hid);
            case 'anzahlKoerner':
            case 'getAnzahlKoerner': return engine.getAnzahlKoerner(hid);
            case 'schreib': appendLog(String(args.length > 0 ? args[0] : '')); return undefined;
            case 'liesZahl': return readTerminalValue('number', hid, args[0]);
            case 'liesZeichenkette': return readTerminalValue('string', hid, args[0]);
            // No matching built-in method: fall through to the generic class/string
            // handling below, which ends in "Unsupported method call" for hamsters.
            default: return HAMSTER_METHOD_NOT_HANDLED;
        }
    }

    return {
        /**
         * Installs the time source for `new Date()`, `Calendar.getInstance()` and
         * `System.currentTimeMillis()`. The runner passes the scheduler's
         * simulation clock; `null` restores the wall clock.
         */
        setClock(source) {
            clock = typeof source === 'function' ? source : wallClock;
        },
        currentTimeMillis() {
            return clock();
        },
        resolveIdentifier(name) {
            if (name === 'Hamster') return { __kind: 'class', name: 'Hamster' };
            if (/^[A-Z][A-Za-z0-9_]*$/.test(name)) return { __kind: 'class', name };
            if (JAVA_PACKAGE_ROOTS.has(name)) return { __kind: 'package', name };
            return undefined;
        },
        createObject(className, args) {
            if (SEMAPHORE_CLASS_NAMES.has(className)) return createJavaSemaphore(className, args);
            if (REENTRANT_LOCK_CLASS_NAMES.has(className)) return createJavaReentrantLock(className, args);
            if (ATOMIC_BOOLEAN_CLASS_NAMES.has(className)) return createJavaAtomicBoolean(className, args);
            if (COUNT_DOWN_LATCH_CLASS_NAMES.has(className)) return createJavaCountDownLatch(className, args);
            if (CYCLIC_BARRIER_CLASS_NAMES.has(className)) return createJavaCyclicBarrier(className, args);
            if (EXCHANGER_CLASS_NAMES.has(className)) return createJavaExchanger(className, args);
            if (isBlockingQueueClassName(className)) return createJavaBlockingQueue(className, args);
            if (className === 'Random' || className === 'java.util.Random') {
                if (args.length > 1) throw new Error('Random constructor expects zero or one seed argument');
                const seed = args.length === 0
                    ? Math.floor(Math.random() * 2 ** 48)
                    : args[0];
                return createJavaRandom(seed);
            }
            if (isDateClassName(className)) {
                if (args.length > 1) throw new Error('Date constructor expects zero arguments or a time in milliseconds');
                return createJavaDate(args.length === 0 ? clock() : args[0]);
            }
            if (isCalendarClassName(className)) return createCalendarFromArgs(args);
            if (TIMER_CLASS_NAMES.has(className)) return createJavaTimer(args);
            if (TIMER_TASK_CLASS_NAMES.has(className)) {
                return { __kind: 'object', className: 'TimerTask', fields: Object.create(null) };
            }
            if (className.endsWith('Hamster')) {
                if (args.length === 0) {
                    return { __kind: 'hamster', id: null, className };
                }
                if (args.length === 1 && args[0]?.__kind === 'hamster') {
                    if (args[0].id === null) return { __kind: 'hamster', id: null, className };
                    const source = findHamster(getEngineState().terrain, args[0].id);
                    if (!source) {
                        throw hamsterError('HamsterNotInitializedException', 'Hamster not initialised');
                    }
                    const id = engine.createHamster(source.y, source.x, source.dir, source.mouth, source.color);
                    return { __kind: 'hamster', id, className };
                }
                if (args.length < 4) throw new Error(className + ' constructor expects at least 4 arguments');
                const id = engine.createHamster(
                    Number(args[0]), Number(args[1]), Number(args[2]), Number(args[3]),
                    args.length >= 5 ? Number(args[4]) : 1,
                );
                return { __kind: 'hamster', id, className };
            }
            const collectionType = collectionClassType(className);
            if (collectionType) {
                return {
                    __kind: 'collection',
                    className,
                    collectionType,
                    values: [],
                    entries: [],
                    fields: Object.create(null),
                };
            }
            return { __kind: 'object', className, fields: Object.create(null) };
        },
        getMember(receiver, property) {
            if (receiver && receiver.__kind === 'package') {
                // `java.util.Calendar` names the same class as an imported `Calendar`.
                return /^[A-Z]/.test(property)
                    ? { __kind: 'class', name: property }
                    : { __kind: 'package', name: receiver.name + '.' + property };
            }
            if (receiver && receiver.__kind === 'class' && receiver.name === 'Hamster') {
                const constants = {
                    NORD: 0, NORTH: 0, OST: 1, EAST: 1, SUED: 2, SOUTH: 2, WEST: 3,
                    BLAU: 0, BLUE: 0, ROT: 1, RED: 1, GRUEN: 2, GREEN: 2,
                    GELB: 3, YELLOW: 3, CYAN: 4, MAGENTA: 5, ORANGE: 6, PINK: 7,
                    GRAU: 8, GRAY: 8, WEISS: 9, WHITE: 9,
                };
                if (Object.prototype.hasOwnProperty.call(constants, property)) return constants[property];
            }
            if (receiver && receiver.__kind === 'class' && isCalendarClassName(receiver.name) &&
                Object.prototype.hasOwnProperty.call(CALENDAR_CONSTANTS, property)) {
                return CALENDAR_CONSTANTS[property];
            }
            if (receiver && (receiver.__kind === 'object' || receiver.__kind === 'collection')) {
                return receiver.fields[property];
            }
            return undefined;
        },
        setMember(receiver, property, value) {
            if (receiver && (receiver.__kind === 'object' || receiver.__kind === 'collection')) {
                receiver.fields[property] = value;
                return true;
            }
            return false;
        },
        callMethod(receiver, methodName, args) {
            if (receiver && (receiver.__kind === 'collection' || receiver.__kind === 'collectionIterator')) {
                return callCollectionMethod(receiver, methodName, args);
            }
            if (receiver && receiver.__kind === 'object' && receiver.className === 'Random') {
                const result = callJavaRandomMethod(receiver, methodName, args);
                if (result !== RANDOM_METHOD_NOT_HANDLED) return result;
            }
            if (receiver && receiver.__kind === 'object' &&
                ATOMIC_BOOLEAN_CLASS_NAMES.has(receiver.className)) {
                const result = callAtomicBooleanMethod(receiver, methodName, args);
                if (result !== null) return result;
                throw unprovidedClassError(receiver.className, methodName);
            }
            if (receiver && receiver.__kind === 'object' && isDateClassName(receiver.className)) {
                const result = callJavaDateMethod(receiver, methodName, args);
                if (result !== TIME_METHOD_NOT_HANDLED) return result;
            }
            if (receiver && receiver.__kind === 'object' && isCalendarClassName(receiver.className)) {
                const result = callJavaCalendarMethod(receiver, methodName, args);
                if (result !== TIME_METHOD_NOT_HANDLED) return result;
            }
            if (receiver && receiver.__kind === 'hamster') {
                methodName = normalizeHamsterMethodName(methodName);
                if (methodName === 'init' || methodName === 'initialisiere') {
                    if (receiver.id !== null) throw hamsterError('HamsterInitializationException', receiver.className + ' is already initialized');
                    if (args.length < 4) throw new Error(methodName + ' expects at least 4 arguments');
                    receiver.id = engine.createHamster(
                        Number(args[0]), Number(args[1]), Number(args[2]), Number(args[3]),
                        args.length >= 5 ? Number(args[4]) : 1,
                    );
                    return undefined;
                }
                if (receiver.id === null) throw hamsterError('HamsterNotInitializedException', receiver.className + ' is not initialized');
                const hid = receiver.id;
                const result = callHamsterInstanceMethod(hid, methodName, args);
                if (result !== HAMSTER_METHOD_NOT_HANDLED) return result;
            }
            if (receiver && receiver.__kind === 'class') return this.callBuiltin(receiver.name + '.' + methodName, args);
            if (typeof receiver === 'string') {
                if (methodName === 'equals') return receiver === String(args?.[0] ?? '');
                if (methodName === 'equalsIgnoreCase') return receiver.toLowerCase() === String(args?.[0] ?? '').toLowerCase();
                if (methodName === 'length') return receiver.length;
            }
            if (receiver && receiver.__kind === 'object' && !receiver.__className) {
                throw unprovidedClassError(receiver.className, methodName);
            }
            throw new Error('Unsupported method call: ' + methodName);
        },
        callBuiltin(name, args) {
            if (name === 'Math.random') return Math.random();
            const separator = name.lastIndexOf('.');
            const receiverName = separator >= 0 ? name.slice(0, separator) : '';
            const rawMethodName = separator >= 0 ? name.slice(separator + 1) : name;
            // `Thread.*` statics never reach here: the runner intercepts them,
            // because they must be able to block and this adapter is synchronous.
            if (receiverName === 'Territorium' || receiverName === 'Territory') {
                return callTerritoryBuiltin(rawMethodName, args);
            }
            if (isCalendarClassName(receiverName) && rawMethodName === 'getInstance') {
                if (args.length > 0) throw new Error('Calendar.getInstance expects no arguments');
                return createJavaCalendar(clock());
            }
            if (simpleClassName(receiverName) === 'System' && rawMethodName === 'currentTimeMillis') {
                return clock();
            }
            if ((receiverName === 'Hamster' || receiverName.endsWith('Hamster')) &&
                (rawMethodName === 'getStandardHamster' ||
                 rawMethodName === 'getStandardHamsterAlsDrehHamster' ||
                 rawMethodName === 'getDefaultHamster')) {
                return { __kind: 'hamster', id: -1, className: 'Hamster' };
            }
            if ((receiverName === 'Hamster' || receiverName.endsWith('Hamster')) &&
                (rawMethodName === 'getAnzahlHamster' || rawMethodName === 'getNumberOfHamsters')) {
                return getEngineState().terrain.hamsters.length;
            }
            const isHamsterReceiver = receiverName === 'Hamster' || receiverName.endsWith('Hamster');
            const methodName = !receiverName || isHamsterReceiver
                ? normalizeHamsterMethodName(rawMethodName)
                : rawMethodName;
            switch (methodName) {
                case 'vor': return engine.vor(defaultHamsterId(args));
                case 'linksUm': return engine.linksUm(defaultHamsterId(args));
                case 'nimm': return engine.nimm(defaultHamsterId(args));
                case 'gib': return engine.gib(defaultHamsterId(args));
                case 'vornFrei': return engine.vornFrei(defaultHamsterId(args));
                case 'kornDa': return engine.kornDa(defaultHamsterId(args));
                case 'maulLeer': return engine.maulLeer(defaultHamsterId(args));
                case 'getReihe': return engine.getReihe(defaultHamsterId(args));
                case 'getSpalte': return engine.getSpalte(defaultHamsterId(args));
                case 'getBlickrichtung': return engine.getBlickrichtung(defaultHamsterId(args));
                case 'anzahlKoerner':
                case 'getAnzahlKoerner': return engine.getAnzahlKoerner(defaultHamsterId(args));
                case 'createHamster':
                    if (args.length < 4) throw new Error('createHamster expects at least 4 arguments');
                    return engine.createHamster(
                        Number(args[0]), Number(args[1]), Number(args[2]), Number(args[3]),
                        args.length >= 5 ? Number(args[4]) : 1,
                    );
                case 'schreib': appendLog(String(args.length > 0 ? args[0] : '')); return undefined;
                case 'liesZahl': return readTerminalValue('number', defaultHamsterId([]), args[0]);
                case 'liesZeichenkette': return readTerminalValue('string', defaultHamsterId([]), args[0]);
                default: throw new Error('Unknown function: ' + name);
            }
        },
    };
}
