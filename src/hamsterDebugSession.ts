import * as vscode from 'vscode';
import {
    collectExecutableLines,
    findExecutableLineAtOrAfter,
    parseProgram,
} from '../lang/hamster-parser.js';
import { HamsterPanel } from './hamsterPanel';
import { resolveTerrain } from './terrainResolver';
import { resolveHamsterClassSources } from './hamsterClassResolver';
import { DebugHostToPanelMessage, DebugPanelToHostMessage, DebugThreadInfo } from './webviewProtocol';

/** The DAP thread a request targets; thread 1 (main) when the client omits it. */
function threadIdOf(request: { arguments?: { threadId?: number } }): number {
    const threadId = request.arguments?.threadId;
    return typeof threadId === 'number' && threadId > 0 ? threadId : 1;
}

interface PendingRequest {
    resolve: (value: any) => void;
    reject: (reason?: any) => void;
    timer: ReturnType<typeof setTimeout>;
}

/** Distributes `Omit` across a union so each member keeps only its own extra fields. */
type DistributiveOmit<T, K extends PropertyKey> = T extends any ? Omit<T, K> : never;

interface DebugBreakpoint {
    verified: boolean;
    line: number;
    message?: string;
}

export interface DebugSessionDeps {
    ensurePanel: () => Promise<HamsterPanel>;
}

/**
 * Inline VS Code debug adapter for Hamster (.ham) programs.
 *
 * The runner itself lives inside the simulator webview.  This adapter
 * translates Debug Adapter Protocol (DAP) requests into `dbg:*`
 * messages posted to the webview, and translates `dbg:*` events from
 * the webview back into DAP events/responses.
 */
export class HamsterDebugSession implements vscode.DebugAdapter {
    private readonly _emitter = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
    public readonly onDidSendMessage = this._emitter.event;

    private _seq = 1;
    private _nextRequestId = 1;
    private _pending = new Map<number, PendingRequest>();
    private _panel: HamsterPanel | undefined;
    private _panelListener: vscode.Disposable | undefined;
    private _panelDisposeListener: vscode.Disposable | undefined;
    private _terminated = false;
    private _stopOnEntry = true;
    private _breakpointsBySource = new Map<string, number[]>();
    private _breakpointQueue: Promise<void> = Promise.resolve();
    private _programPath: string | undefined;
    private _programSource: string | undefined;

    constructor(private readonly deps: DebugSessionDeps) {}

    // ── vscode.DebugAdapter ─────────────────────────────────────────────────
    handleMessage(message: vscode.DebugProtocolMessage): void {
        const msg = message as any;
        if (!msg || msg.type !== 'request') return;
        this.dispatchRequest(msg).catch(err => {
            this.sendErrorResponse(msg, err?.message ?? String(err));
        });
    }

    dispose(): void {
        this._panelListener?.dispose();
        this._panelDisposeListener?.dispose();
        this.rejectAllPending(new Error('Debug session disposed.'));
        this._emitter.dispose();
    }

    private rejectAllPending(reason: Error): void {
        this._pending.forEach(p => {
            clearTimeout(p.timer);
            p.reject(reason);
        });
        this._pending.clear();
    }

    // ── DAP helpers ─────────────────────────────────────────────────────────
    private send(msg: any): void {
        msg.seq = this._seq++;
        this._emitter.fire(msg as vscode.DebugProtocolMessage);
    }

    private sendResponse(request: any, body?: any): void {
        this.send({
            type: 'response',
            request_seq: request.seq,
            success: true,
            command: request.command,
            body,
        });
    }

    private sendErrorResponse(request: any, message: string): void {
        this.send({
            type: 'response',
            request_seq: request.seq,
            success: false,
            command: request.command,
            message,
            body: { error: { id: 1, format: message, showUser: true } },
        });
    }

    private sendEvent(event: string, body?: any): void {
        this.send({ type: 'event', event, body });
    }

    // ── Panel bridge ────────────────────────────────────────────────────────
    private toPanel(msg: DebugHostToPanelMessage): void {
        if (!this._panel) return;
        this._panel.postDebug(msg);
    }

    private requestFromPanel<T = any>(
        message: DistributiveOmit<Extract<DebugHostToPanelMessage, { requestId: number }>, 'requestId'>,
        timeoutMs = 5000,
    ): Promise<T> {
        const requestId = this._nextRequestId++;
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                if (this._pending.has(requestId)) {
                    this._pending.delete(requestId);
                    reject(new Error(`Timeout waiting for ${message.type}`));
                }
            }, timeoutMs);
            this._pending.set(requestId, { resolve, reject, timer });
            this.toPanel({ ...message, requestId } as DebugHostToPanelMessage);
        });
    }

    private handlePanelMessage = (msg: DebugPanelToHostMessage): void => {
        switch (msg.type) {
            case 'dbg:stopped':
                this.sendEvent('stopped', {
                    reason: msg.reason || 'step',
                    threadId: msg.threadId,
                    // Execution is cooperative: only one hamster is ever
                    // mid-action, so stopping really does stop them all.
                    allThreadsStopped: true,
                    text: msg.text,
                });
                return;
            case 'dbg:threadStarted':
                this.sendEvent('thread', { reason: 'started', threadId: msg.threadId });
                return;
            case 'dbg:threadExited':
                this.sendEvent('thread', { reason: 'exited', threadId: msg.threadId });
                return;
            case 'dbg:terminated':
                if (!this._terminated) {
                    this._terminated = true;
                    this.sendEvent('terminated');
                }
                return;
            case 'dbg:output':
                this.sendEvent('output', {
                    category: msg.category || 'stdout',
                    output: msg.output ?? '',
                });
                return;
            case 'dbg:stackTrace':
            case 'dbg:scopes':
            case 'dbg:variables':
            case 'dbg:evaluate': {
                const pending = this._pending.get(msg.requestId);
                if (pending) {
                    this._pending.delete(msg.requestId);
                    clearTimeout(pending.timer);
                    pending.resolve(msg);
                }
                return;
            }
        }
    };

    // ── DAP dispatch ────────────────────────────────────────────────────────
    private async dispatchRequest(request: any): Promise<void> {
        switch (request.command) {
            case 'initialize':
                this.sendResponse(request, {
                    supportsConfigurationDoneRequest: true,
                    supportsEvaluateForHovers: true,
                    supportsTerminateRequest: true,
                    supportsRestartRequest: false,
                    supportsSetVariable: false,
                    supportsBreakpointLocationsRequest: false,
                });
                this.sendEvent('initialized');
                return;

            case 'launch':
                await this.handleLaunch(request);
                return;

            case 'configurationDone':
                this.sendResponse(request);
                return;

            case 'setBreakpoints':
                await this.enqueueSetBreakpoints(request);
                return;

            case 'threads':
                await this.handleThreads(request);
                return;

            case 'stackTrace':
                await this.handleStackTrace(request);
                return;

            case 'scopes':
                await this.handleScopes(request);
                return;

            case 'variables':
                await this.handleVariables(request);
                return;

            case 'continue':
                this.sendResponse(request, { allThreadsContinued: true });
                this.toPanel({ type: 'dbg:continue' });
                return;

            case 'next':
                this.sendResponse(request);
                this.toPanel({ type: 'dbg:next', threadId: threadIdOf(request) });
                return;

            case 'stepIn':
                this.sendResponse(request);
                this.toPanel({ type: 'dbg:stepIn', threadId: threadIdOf(request) });
                return;

            case 'stepOut':
                this.sendResponse(request);
                this.toPanel({ type: 'dbg:stepOut', threadId: threadIdOf(request) });
                return;

            case 'pause':
                this.sendResponse(request);
                this.toPanel({ type: 'dbg:pause' });
                return;

            case 'evaluate':
                await this.handleEvaluate(request);
                return;

            case 'disconnect':
            case 'terminate':
                this.toPanel({ type: 'dbg:disconnect' });
                this.sendResponse(request);
                if (!this._terminated) {
                    this._terminated = true;
                    this.sendEvent('terminated');
                }
                return;

            default:
                this.sendErrorResponse(request, `Unsupported DAP command: ${request.command}`);
        }
    }

    private async handleLaunch(request: any): Promise<void> {
        const args = request.arguments || {};
        const programPath: string | undefined = args.program;
        if (!programPath) {
            this.sendErrorResponse(request, 'Missing "program" in launch configuration.');
            this.sendEvent('terminated');
            return;
        }
        this._programPath = programPath;
        this._stopOnEntry = args.stopOnEntry !== false;

        try {
            if (!await vscode.workspace.saveAll()) {
                this.sendErrorResponse(request, 'Debug launch cancelled because files were not saved.');
                this.sendEvent('terminated');
                return;
            }
        } catch (e: any) {
            this.sendErrorResponse(request, `Cannot save workspace files: ${e?.message ?? e}`);
            this.sendEvent('terminated');
            return;
        }

        let source: string;
        const fileUri = vscode.Uri.file(programPath);
        try {
            source = await this.loadSource(programPath);
        } catch (e: any) {
            this.sendErrorResponse(request, `Cannot read program "${programPath}": ${e?.message ?? e}`);
            this.sendEvent('terminated');
            return;
        }
        this._programSource = source;
        const classSources = await resolveHamsterClassSources(fileUri);

        // Resolve the matching terrain file (.ter) next to the .ham file, if any.
        const terrain = await resolveTerrain(fileUri);

        // Ensure the simulator panel exists and wire up the message bridge.
        try {
            this._panel = await this.deps.ensurePanel();
        } catch (e: any) {
            this.sendErrorResponse(request, `Cannot open Hamster simulator: ${e?.message ?? e}`);
            this.sendEvent('terminated');
            return;
        }
        this._panelListener = this._panel.onDidReceiveDebugMessage(this.handlePanelMessage);
        this._panelDisposeListener = this._panel.onDidDispose(() => {
            this.rejectAllPending(new Error('Hamster simulator panel closed.'));
            if (!this._terminated) {
                this._terminated = true;
                this.sendEvent('terminated');
            }
        });
        this._panel.reveal();
        this._panel.setProgramUri(fileUri);

        if (terrain) {
            this._panel.sendTerrainContent(terrain);
        } else {
            this._panel.resetTerrain();
        }

        // Collect breakpoints already registered for this source (if any).
        const bps = this._breakpointsBySource.get(this.normalizePath(programPath)) || [];

        this.sendResponse(request);
        this.toPanel({
            type: 'dbg:launch',
            source,
            classSources,
            stopOnEntry: this._stopOnEntry,
            breakpoints: bps,
        });
    }

    private enqueueSetBreakpoints(request: any): Promise<void> {
        const operation = this._breakpointQueue.then(() => this.handleSetBreakpoints(request));
        // Keep the queue usable after a failed request; dispatchRequest still observes the failure.
        this._breakpointQueue = operation.then(() => undefined, () => undefined);
        return operation;
    }

    private async handleSetBreakpoints(request: any): Promise<void> {
        const args = request.arguments || {};
        const sourcePath: string | undefined = args.source?.path;
        const inputBps: any[] = args.breakpoints || [];
        const requestedLines = inputBps.map(b => b.line | 0);
        let executableLines: number[] = [];
        let verificationError: string | undefined;

        if (!sourcePath) {
            verificationError = 'Breakpoint source has no file path.';
        } else {
            try {
                const normalizedSourcePath = this.normalizePath(sourcePath);
                const isRunningProgram = this._programPath &&
                    normalizedSourcePath === this.normalizePath(this._programPath);
                const source = isRunningProgram && this._programSource !== undefined
                    ? this._programSource
                    : await this.loadSource(sourcePath, normalizedSourcePath);
                const ast = parseProgram(source);
                executableLines = collectExecutableLines(ast);
                if (executableLines.length === 0) {
                    verificationError = 'The program contains no executable statements.';
                }
            } catch (error: any) {
                verificationError = `Cannot verify breakpoints: ${error?.message ?? String(error)}`;
            }
        }

        const breakpoints: DebugBreakpoint[] = requestedLines.map(requestedLine => {
            if (requestedLine <= 0) {
                return {
                    verified: false,
                    line: requestedLine,
                    message: 'Breakpoint line must be positive.',
                };
            }
            if (verificationError) {
                return { verified: false, line: requestedLine, message: verificationError };
            }
            const line = findExecutableLineAtOrAfter(requestedLine, executableLines);
            if (line === null) {
                return {
                    verified: false,
                    line: requestedLine,
                    message: `No executable statement at or after line ${requestedLine}.`,
                };
            }
            return {
                verified: true,
                line,
                message: line === requestedLine
                    ? undefined
                    : `Breakpoint moved from line ${requestedLine} to executable line ${line}.`,
            };
        });
        const lines = [...new Set(
            breakpoints
                .filter(breakpoint => breakpoint.verified)
                .map(breakpoint => breakpoint.line)
        )];
        const shouldUpdateActiveBreakpoints = inputBps.length === 0 || !verificationError;
        if (sourcePath && shouldUpdateActiveBreakpoints) {
            this._breakpointsBySource.set(this.normalizePath(sourcePath), lines);
        }
        // Forward to the webview if this matches the program we're debugging.
        if (shouldUpdateActiveBreakpoints && this._programPath && sourcePath &&
            this.normalizePath(sourcePath) === this.normalizePath(this._programPath)) {
            this.toPanel({ type: 'dbg:setBreakpoints', lines });
        }
        this.sendResponse(request, {
            breakpoints,
        });
    }

    /**
     * Loads source text for a `.ham` file, preferring the matching open
     * `TextDocument` (so unsaved edits are honored) and falling back to disk.
     * Used by both launch and breakpoint verification so they always agree
     * on the executed/verified source.
     */
    private async loadSource(
        sourcePath: string,
        normalizedSourcePath: string = this.normalizePath(sourcePath)
    ): Promise<string> {
        const openDocument = vscode.workspace.textDocuments.find(document =>
            this.normalizePath(document.uri.fsPath) === normalizedSourcePath
        );
        if (openDocument) {
            return openDocument.getText();
        }
        const data = await vscode.workspace.fs.readFile(vscode.Uri.file(sourcePath));
        return new TextDecoder('utf-8').decode(data);
    }

    private async handleThreads(request: any): Promise<void> {
        try {
            const res: any = await this.requestFromPanel({ type: 'dbg:threads' });
            const threads = (res.threads || []).map((thread: DebugThreadInfo) => ({
                id: thread.id,
                // Surfacing why a hamster is stopped is the whole point of
                // listing blocked threads, so it goes in the visible name.
                name: thread.detail ? `${thread.name} (${thread.detail})` : thread.name,
            }));
            this.sendResponse(request, {
                threads: threads.length > 0 ? threads : [{ id: 1, name: 'main' }],
            });
        } catch (e: any) {
            this.sendErrorResponse(request, e?.message ?? String(e));
        }
    }

    private async handleStackTrace(request: any): Promise<void> {
        try {
            const res: any = await this.requestFromPanel({
                type: 'dbg:stackTrace', threadId: threadIdOf(request),
            });
            const sourcePath = this._programPath;
            const frames = (res.frames || []).map((f: any) => ({
                id: f.id,
                name: f.name,
                line: f.line,
                column: f.column,
                source: sourcePath ? { name: sourcePath.split(/[\\/]/).pop(), path: sourcePath } : undefined,
            }));
            this.sendResponse(request, { stackFrames: frames, totalFrames: frames.length });
        } catch (e: any) {
            this.sendErrorResponse(request, e?.message ?? String(e));
        }
    }

    private async handleScopes(request: any): Promise<void> {
        try {
            const frameId = request.arguments?.frameId | 0;
            const res: any = await this.requestFromPanel({ type: 'dbg:scopes', frameId });
            this.sendResponse(request, { scopes: res.scopes || [] });
        } catch (e: any) {
            this.sendErrorResponse(request, e?.message ?? String(e));
        }
    }

    private async handleVariables(request: any): Promise<void> {
        try {
            const variablesReference = request.arguments?.variablesReference | 0;
            const res: any = await this.requestFromPanel({ type: 'dbg:variables', variablesReference });
            this.sendResponse(request, { variables: res.variables || [] });
        } catch (e: any) {
            this.sendErrorResponse(request, e?.message ?? String(e));
        }
    }

    private async handleEvaluate(request: any): Promise<void> {
        try {
            const expression = String(request.arguments?.expression ?? '');
            const frameId = request.arguments?.frameId;
            const res: any = await this.requestFromPanel({ type: 'dbg:evaluate', expression, frameId });
            if (res.error) {
                throw new Error(String(res.error));
            }
            this.sendResponse(request, { result: String(res.result ?? ''), variablesReference: 0 });
        } catch (e: any) {
            this.sendErrorResponse(request, e?.message ?? String(e));
        }
    }

    // ── Misc helpers ────────────────────────────────────────────────────────
    private normalizePath(p: string): string {
        return p.replace(/\\/g, '/').toLowerCase();
    }
}

/**
 * Debug configuration provider — fills in defaults when the user
 * presses F5 without a launch.json (or with an empty entry).
 */
export class HamsterDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
    resolveDebugConfiguration(
        _folder: vscode.WorkspaceFolder | undefined,
        config: vscode.DebugConfiguration,
        _token?: vscode.CancellationToken,
    ): vscode.ProviderResult<vscode.DebugConfiguration> {
        if (!config.type && !config.request && !config.name) {
            const editor = vscode.window.activeTextEditor;
            if (editor && editor.document.languageId === 'hamster') {
                config.type = 'hamster';
                config.name = 'Run Hamster Program';
                config.request = 'launch';
                config.program = editor.document.uri.fsPath;
                config.stopOnEntry = true;
            }
        }
        if (!config.program) {
            const editor = vscode.window.activeTextEditor;
            if (editor && editor.document.languageId === 'hamster') {
                config.program = editor.document.uri.fsPath;
            }
        }
        if (!config.program) {
            return vscode.window.showInformationMessage('Cannot find a Hamster program to debug.').then(() => undefined);
        }
        return config;
    }
}
