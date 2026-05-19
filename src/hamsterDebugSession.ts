import * as vscode from 'vscode';
import { HamsterPanel } from './hamsterPanel';

interface PendingRequest {
    resolve: (value: any) => void;
    reject: (reason?: any) => void;
    timer: ReturnType<typeof setTimeout>;
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
    private _programPath: string | undefined;

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
        this._pending.forEach(p => clearTimeout(p.timer));
        this._pending.clear();
        this._emitter.dispose();
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
    private toPanel(msg: any): void {
        if (!this._panel) return;
        this._panel.postDebug(msg);
    }

    private requestFromPanel<T = any>(type: string, extra: Record<string, any> = {}, timeoutMs = 5000): Promise<T> {
        const requestId = this._nextRequestId++;
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                if (this._pending.has(requestId)) {
                    this._pending.delete(requestId);
                    reject(new Error(`Timeout waiting for ${type}`));
                }
            }, timeoutMs);
            this._pending.set(requestId, { resolve, reject, timer });
            this.toPanel({ type, requestId, ...extra });
        });
    }

    private handlePanelMessage = (msg: any): void => {
        if (!msg || typeof msg.type !== 'string') return;
        switch (msg.type) {
            case 'dbg:stopped':
                this.sendEvent('stopped', {
                    reason: msg.reason || 'step',
                    threadId: 1,
                    allThreadsStopped: true,
                    text: msg.text,
                });
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
                this.handleSetBreakpoints(request);
                return;

            case 'threads':
                this.sendResponse(request, { threads: [{ id: 1, name: 'Hamster' }] });
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
                this.toPanel({ type: 'dbg:next' });
                return;

            case 'stepIn':
                this.sendResponse(request);
                this.toPanel({ type: 'dbg:stepIn' });
                return;

            case 'stepOut':
                this.sendResponse(request);
                this.toPanel({ type: 'dbg:stepOut' });
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

        let source: string;
        const fileUri = vscode.Uri.file(programPath);
        try {
            const data = await vscode.workspace.fs.readFile(fileUri);
            source = new TextDecoder('utf-8').decode(data);
        } catch (e: any) {
            this.sendErrorResponse(request, `Cannot read program "${programPath}": ${e?.message ?? e}`);
            this.sendEvent('terminated');
            return;
        }

        // Try to find a matching terrain file (.ter) next to the .ham file.
        const terrain = await this.findTerrain(fileUri);

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
            if (!this._terminated) {
                this._terminated = true;
                this.sendEvent('terminated');
            }
        });
        this._panel.reveal();

        if (terrain) {
            this._panel.sendTerrainContent(terrain);
        }

        // Collect breakpoints already registered for this source (if any).
        const bps = this._breakpointsBySource.get(this.normalizePath(programPath)) || [];

        this.sendResponse(request);
        this.toPanel({
            type: 'dbg:launch',
            source,
            stopOnEntry: this._stopOnEntry,
            breakpoints: bps,
        });
    }

    private handleSetBreakpoints(request: any): void {
        const args = request.arguments || {};
        const sourcePath: string | undefined = args.source?.path;
        const inputBps: any[] = args.breakpoints || [];
        const lines = inputBps.map(b => b.line | 0).filter(n => n > 0);
        if (sourcePath) {
            this._breakpointsBySource.set(this.normalizePath(sourcePath), lines);
        }
        // Forward to the webview if this matches the program we're debugging.
        if (this._programPath && sourcePath &&
            this.normalizePath(sourcePath) === this.normalizePath(this._programPath)) {
            this.toPanel({ type: 'dbg:setBreakpoints', lines });
        }
        this.sendResponse(request, {
            breakpoints: inputBps.map(b => ({ verified: true, line: b.line })),
        });
    }

    private async handleStackTrace(request: any): Promise<void> {
        try {
            const res: any = await this.requestFromPanel('dbg:stackTrace');
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
            const res: any = await this.requestFromPanel('dbg:scopes', { frameId });
            this.sendResponse(request, { scopes: res.scopes || [] });
        } catch (e: any) {
            this.sendErrorResponse(request, e?.message ?? String(e));
        }
    }

    private async handleVariables(request: any): Promise<void> {
        try {
            const variablesReference = request.arguments?.variablesReference | 0;
            const res: any = await this.requestFromPanel('dbg:variables', { variablesReference });
            this.sendResponse(request, { variables: res.variables || [] });
        } catch (e: any) {
            this.sendErrorResponse(request, e?.message ?? String(e));
        }
    }

    private async handleEvaluate(request: any): Promise<void> {
        try {
            const expression = String(request.arguments?.expression ?? '');
            const res: any = await this.requestFromPanel('dbg:evaluate', { expression });
            this.sendResponse(request, { result: String(res.result ?? ''), variablesReference: 0 });
        } catch (e: any) {
            this.sendErrorResponse(request, e?.message ?? String(e));
        }
    }

    // ── Misc helpers ────────────────────────────────────────────────────────
    private normalizePath(p: string): string {
        return p.replace(/\\/g, '/').toLowerCase();
    }

    private async findTerrain(hamUri: vscode.Uri): Promise<string | undefined> {
        const dirUri = vscode.Uri.joinPath(hamUri, '..');
        const uriPath = hamUri.path;
        const lastSlash = uriPath.lastIndexOf('/');
        const fileName = uriPath.substring(lastSlash + 1);
        const baseName = fileName.endsWith('.ham') ? fileName.slice(0, -4) : fileName;
        const exactTerUri = vscode.Uri.joinPath(dirUri, baseName + '.ter');
        const decoder = new TextDecoder('utf-8');
        try {
            const data = await vscode.workspace.fs.readFile(exactTerUri);
            return decoder.decode(data);
        } catch { /* fall through */ }
        try {
            const entries = await vscode.workspace.fs.readDirectory(dirUri);
            const terEntry = entries.find(([name]) => name.endsWith('.ter'));
            if (terEntry) {
                const data = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dirUri, terEntry[0]));
                return decoder.decode(data);
            }
        } catch { /* ignore */ }
        return undefined;
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
