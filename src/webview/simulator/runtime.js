/**
 * Hamster runtime adapter: bridges the generic OO-method-call interface the
 * language runner expects (`resolveIdentifier`/`createObject`/`getMember`/
 * `setMember`/`callMethod`/`callBuiltin`) to the simulator engine's
 * `vor`/`nimm`/... built-in API, plus the `Territorium`/`Territory` static
 * helpers and terminal I/O glue. Moved out of `hamsterPanel.ts`'s inline
 * script unchanged in behavior.
 */
import { isWallAt, insideTerrain } from '../shared/terrainEngineState.js';
import { hamsterError } from './engine.js';

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

/** Runtime-created placeholder objects stand in for Java library classes the simulator doesn't provide. */
function unprovidedClassError(className, methodName) {
    return new Error(`${className}.${methodName}: class ${className} is not provided by the Hamster simulator`);
}

function defaultHamsterId(args) {
    if (!args || args.length === 0) return -1;
    const first = args[0];
    if (first && typeof first === 'object' && first.__kind === 'hamster') return Number(first.id);
    return Number(first);
}

/**
 * @param {object} deps
 * @param {object} deps.engine the simulator engine's built-in API (vor/nimm/...)
 * @param {() => object} deps.getEngineState live (non-cloned) engine state
 * @param {(text: string) => void} deps.appendLog writes a line to the on-screen log
 * @param {(kind: 'number'|'string', hamsterId: number, prompt: string) => (number|string)} deps.readTerminalValue
 */
export function createHamsterRuntime({ engine, getEngineState, appendLog, readTerminalValue }) {
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
        resolveIdentifier(name) {
            if (name === 'Hamster') return { __kind: 'class', name: 'Hamster' };
            if (/^[A-Z][A-Za-z0-9_]*$/.test(name)) return { __kind: 'class', name };
            return undefined;
        },
        createObject(className, args) {
            if (className.endsWith('Hamster')) {
                if (args.length === 0) {
                    return { __kind: 'hamster', id: null, className };
                }
                if (args.length < 4) throw new Error(className + ' constructor expects at least 4 arguments');
                const id = engine.createHamster(
                    Number(args[0]), Number(args[1]), Number(args[2]), Number(args[3]),
                    args.length >= 5 ? Number(args[4]) : 1,
                );
                return { __kind: 'hamster', id, className };
            }
            return { __kind: 'object', className, fields: Object.create(null) };
        },
        getMember(receiver, property) {
            if (receiver && receiver.__kind === 'class' && receiver.name === 'Hamster') {
                const constants = {
                    NORD: 0, NORTH: 0, OST: 1, EAST: 1, SUED: 2, SOUTH: 2, WEST: 3,
                    BLAU: 0, BLUE: 0, ROT: 1, RED: 1, GRUEN: 2, GREEN: 2,
                    GELB: 3, YELLOW: 3, CYAN: 4, MAGENTA: 5, ORANGE: 6, PINK: 7,
                    GRAU: 8, GRAY: 8, WEISS: 9, WHITE: 9,
                };
                if (Object.prototype.hasOwnProperty.call(constants, property)) return constants[property];
            }
            if (receiver && receiver.__kind === 'object') return receiver.fields[property];
            return undefined;
        },
        setMember(receiver, property, value) {
            if (receiver && receiver.__kind === 'object') { receiver.fields[property] = value; return true; }
            return false;
        },
        callMethod(receiver, methodName, args) {
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
