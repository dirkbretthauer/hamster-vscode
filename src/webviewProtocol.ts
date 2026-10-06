/**
 * Shared message protocols exchanged across the extension host / webview
 * boundaries (simulator panel, debug adapter bridge, terrain editor).
 *
 * Every message a webview sends to the extension host is untrusted input:
 * a compromised or buggy webview could post arbitrary JSON. The type guards
 * below narrow `unknown` payloads before any field is read, so malformed or
 * unknown messages are rejected instead of silently mutating editor state.
 */

export type SimulatorCommand = 'compile' | 'run' | 'step' | 'stop' | 'reset';

const SIMULATOR_COMMANDS: readonly SimulatorCommand[] = ['compile', 'run', 'step', 'stop', 'reset'];

// ── Extension host → simulator webview ──────────────────────────────────────

export type DebugHostToPanelMessage =
    | { type: 'dbg:launch'; source: string; classSources: string[]; stopOnEntry: boolean; breakpoints: number[] }
    | { type: 'dbg:setBreakpoints'; lines: number[] }
    | { type: 'dbg:continue' }
    // Stepping advances the thread the user has selected; `frameId` and
    // `variablesReference` already encode their thread, so those need no id.
    | { type: 'dbg:next'; threadId: number }
    | { type: 'dbg:stepIn'; threadId: number }
    | { type: 'dbg:stepOut'; threadId: number }
    | { type: 'dbg:pause' }
    | { type: 'dbg:stackTrace'; requestId: number; threadId: number }
    | { type: 'dbg:threads'; requestId: number }
    | { type: 'dbg:scopes'; requestId: number; frameId: number }
    | { type: 'dbg:variables'; requestId: number; variablesReference: number }
    | { type: 'dbg:evaluate'; requestId: number; expression: string; frameId: number | undefined }
    | { type: 'dbg:disconnect' };

/** One live hamster thread, as reported to the debugger's thread list. */
export interface DebugThreadInfo {
    id: number;
    name: string;
    status: string;
    /** What the thread is waiting for, when it is not runnable. */
    detail?: string;
}

export type HostToPanelMessage =
    | { type: 'loadProgram'; source: string; classSources: string[] }
    | { type: 'loadTerrain'; terrain: string }
    | { type: 'resetTerrain' }
    | { type: 'command'; command: SimulatorCommand }
    | DebugHostToPanelMessage;

// ── Simulator webview → extension host ──────────────────────────────────────

export type DebugPanelToHostMessage =
    | { type: 'dbg:stopped'; reason: string; threadId: number; line?: number; column?: number; text?: string }
    /** The whole program ended — never a single thread. */
    | { type: 'dbg:terminated' }
    | { type: 'dbg:threadStarted'; threadId: number; name: string }
    | { type: 'dbg:threadExited'; threadId: number }
    | { type: 'dbg:threads'; requestId: number; threads: DebugThreadInfo[] }
    | { type: 'dbg:output'; category?: string; output: string; threadId?: number }
    | { type: 'dbg:stackTrace'; requestId: number; threadId: number; frames: unknown[] }
    | { type: 'dbg:scopes'; requestId: number; scopes: unknown[] }
    | { type: 'dbg:variables'; requestId: number; variables: unknown[] }
    | { type: 'dbg:evaluate'; requestId: number; result?: string; error?: string };

export type PanelToHostMessage =
    | { type: 'error'; message: string }
    | { type: 'info'; message: string }
    | { type: 'commandRequest'; command: Extract<SimulatorCommand, 'compile' | 'run' | 'step'> }
    | { type: 'highlightLine'; line: number }
    | { type: 'clearHighlight' }
    | DebugPanelToHostMessage;

const DEBUG_MESSAGE_PREFIX = 'dbg:';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

/** Narrows a raw webview payload to a known `dbg:*` message without validating its extra fields. */
export function isDebugMessage(value: unknown): value is { type: string } & Record<string, unknown> {
    return isRecord(value) && typeof value.type === 'string' && value.type.startsWith(DEBUG_MESSAGE_PREFIX);
}

/** Validates a message posted by the simulator webview to the extension host. */
function isDebugThreadInfo(value: unknown): value is DebugThreadInfo {
    return isRecord(value) &&
        typeof value.id === 'number' &&
        typeof value.name === 'string' &&
        typeof value.status === 'string' &&
        (value.detail === undefined || typeof value.detail === 'string');
}

export function isPanelToHostMessage(value: unknown): value is PanelToHostMessage {
    if (!isRecord(value) || typeof value.type !== 'string') return false;
    switch (value.type) {
        case 'error':
        case 'info':
            return typeof value.message === 'string';
        case 'commandRequest':
            return value.command === 'compile' || value.command === 'run' || value.command === 'step';
        case 'highlightLine':
            return typeof value.line === 'number';
        case 'clearHighlight':
            return true;
        case 'dbg:stopped':
            return typeof value.reason === 'string' && typeof value.threadId === 'number';
        case 'dbg:terminated':
            return true;
        case 'dbg:threadStarted':
            return typeof value.threadId === 'number' && typeof value.name === 'string';
        case 'dbg:threadExited':
            return typeof value.threadId === 'number';
        case 'dbg:threads':
            return typeof value.requestId === 'number' && Array.isArray(value.threads) &&
                value.threads.every(isDebugThreadInfo);
        case 'dbg:output':
            return typeof value.output === 'string' &&
                (value.threadId === undefined || typeof value.threadId === 'number');
        case 'dbg:stackTrace':
            return typeof value.requestId === 'number' && typeof value.threadId === 'number' &&
                Array.isArray(value.frames);
        case 'dbg:scopes':
            return typeof value.requestId === 'number' && Array.isArray(value.scopes);
        case 'dbg:variables':
            return typeof value.requestId === 'number' && Array.isArray(value.variables);
        case 'dbg:evaluate':
            return typeof value.requestId === 'number' &&
                (value.result === undefined || typeof value.result === 'string') &&
                (value.error === undefined || typeof value.error === 'string');
        default:
            return false;
    }
}

// ── Terrain editor webview ↔ extension host ──────────────────────────────────

export type HostToTerrainEditorMessage = { type: 'loadTerrain'; terrain: string };

export type TerrainEditorToHostMessage = { type: 'terrainChanged'; content: string };

/** Validates a message posted by the terrain editor webview to the extension host. */
export function isTerrainEditorToHostMessage(value: unknown): value is TerrainEditorToHostMessage {
    return isRecord(value) && value.type === 'terrainChanged' && typeof value.content === 'string';
}

export function isSimulatorCommand(value: unknown): value is SimulatorCommand {
    return typeof value === 'string' && (SIMULATOR_COMMANDS as readonly string[]).includes(value);
}
