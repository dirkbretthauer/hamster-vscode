import * as vscode from 'vscode';
import { HamsterDiagnostics } from './diagnostics';
import { getNonce, loadLangScripts } from './utils';

export interface HamsterPanelOptions {
    initialTerrain?: string;
    initialProgram?: string;
}

export class HamsterPanel {
    private disposables: vscode.Disposable[] = [];
    private _onDidDispose = new vscode.EventEmitter<void>();
    public readonly onDidDispose = this._onDidDispose.event;
    private constructor(
        private context: vscode.ExtensionContext,
        private diagnostics: HamsterDiagnostics,
        private panel: vscode.WebviewPanel,
        private options: HamsterPanelOptions = {},
    ) {
        this.panel.webview.onDidReceiveMessage(
            msg => this.handleMessage(msg),
            null,
            this.disposables
        );

        this.panel.onDidDispose(() => {
            this.cleanUp();
            this._onDidDispose.fire();
        }, null, this.disposables);
    }

    static async create(
        context: vscode.ExtensionContext,
        diagnostics: HamsterDiagnostics,
        options: HamsterPanelOptions = {},
    ): Promise<HamsterPanel> {
        const panel = vscode.window.createWebviewPanel(
            'hamsterSimulator',
            'Hamster Simulator',
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(context.extensionUri, 'lang'),
                    vscode.Uri.joinPath(context.extensionUri, 'assets'),
                ],
            }
        );

        const scripts = await loadLangScripts(context.extensionUri);
        const instance = new HamsterPanel(context, diagnostics, panel, options);
        instance.panel.webview.html = instance.getHtmlContent(scripts.lexerCode, scripts.parserCode, scripts.runnerCode);
        return instance;
    }

    reveal() {
        this.panel.reveal(vscode.ViewColumn.Beside);
    }

    sendProgram(source: string) {
        this.panel.webview.postMessage({ type: 'loadProgram', source });
    }

    async sendTerrain(hamUri: vscode.Uri) {
        const dirUri = vscode.Uri.joinPath(hamUri, '..');
        const uriPath = hamUri.path;
        const lastSlash = uriPath.lastIndexOf('/');
        const fileName = uriPath.substring(lastSlash + 1);
        const baseName = fileName.endsWith('.ham') ? fileName.slice(0, -4) : fileName;
        const exactTerUri = vscode.Uri.joinPath(dirUri, baseName + '.ter');
        const decoder = new TextDecoder('utf-8');
        let terContent: string | undefined;

        try {
            const data = await vscode.workspace.fs.readFile(exactTerUri);
            terContent = decoder.decode(data);
        } catch {
            try {
                const entries = await vscode.workspace.fs.readDirectory(dirUri);
                const terEntry = entries.find(([name]) => name.endsWith('.ter'));
                if (terEntry) {
                    const data = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dirUri, terEntry[0]));
                    terContent = decoder.decode(data);
                }
            } catch { /* ignore */ }
        }

        if (terContent) {
            this.panel.webview.postMessage({ type: 'loadTerrain', terrain: terContent });
        }
    }

    sendTerrainContent(content: string) {
        this.panel.webview.postMessage({ type: 'loadTerrain', terrain: content });
    }

    postCommand(command: string) {
        this.panel.webview.postMessage({ type: 'command', command });
    }

    private handleMessage(msg: any) {
        switch (msg.type) {
            case 'error':
                vscode.window.showErrorMessage(`Hamster: ${msg.message}`);
                break;
            case 'info':
                vscode.window.showInformationMessage(`Hamster: ${msg.message}`);
                break;
            case 'highlightLine':
                this.highlightLine(msg.line);
                break;
            case 'clearHighlight':
                this.clearHighlight();
                break;
        }
    }

    private findHamsterEditor(): vscode.TextEditor | undefined {
        return vscode.window.visibleTextEditors.find(e => e.document.languageId === 'hamster');
    }

    private highlightLine(line: number) {
        const editor = this.findHamsterEditor();
        if (!editor) return;
        const range = new vscode.Range(line - 1, 0, line - 1, 1000);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        editor.setDecorations(stepHighlight, [{ range }]);
    }

    private clearHighlight() {
        const editor = this.findHamsterEditor();
        if (editor) {
            editor.setDecorations(stepHighlight, []);
        }
    }

    private getHtmlContent(lexerCode: string, parserCode: string, runnerCode: string): string {
        const webview = this.panel.webview;
        const assetsUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'assets')
        );
        const nonce = getNonce();
        const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
        const escapedTerrain = escapeAttr(this.options.initialTerrain || '');
        const escapedProgram = escapeAttr(this.options.initialProgram || '');

        return /*html*/`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none';
                   img-src ${webview.cspSource} data:;
                   style-src ${webview.cspSource} 'unsafe-inline';
                   script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Hamster Simulator</title>
    <style>
        body {
            margin: 0;
            padding: 8px;
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
        }
        .toolbar {
            display: flex;
            gap: 6px;
            margin-bottom: 8px;
            flex-wrap: wrap;
            align-items: center;
        }
        .toolbar button {
            padding: 4px 12px;
            cursor: pointer;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 2px;
            font-size: 13px;
        }
        .toolbar button:hover {
            background: var(--vscode-button-hoverBackground);
        }
        .toolbar .speed-control {
            display: flex;
            align-items: center;
            gap: 4px;
            margin-left: 8px;
        }
        .toolbar .speed-control label {
            font-size: 12px;
            opacity: 0.8;
        }
        .toolbar .speed-control input[type="range"] {
            width: 80px;
        }
        #canvas-container {
            border: 1px solid var(--vscode-panel-border);
            background: #f9f5e7;
            display: inline-block;
            margin-bottom: 8px;
        }
        canvas { display: block; }
        #log {
            max-height: 160px;
            overflow-y: auto;
            padding: 4px 8px;
            font-family: var(--vscode-editor-font-family);
            font-size: 12px;
            border: 1px solid var(--vscode-panel-border);
            background: var(--vscode-editor-background);
        }
        #log .log-error { color: var(--vscode-errorForeground); }
        #status {
            font-size: 12px;
            opacity: 0.8;
            padding: 4px 0;
        }
        .edit-toolbar {
            display: flex;
            gap: 4px;
            margin-bottom: 8px;
            flex-wrap: wrap;
            align-items: center;
            font-size: 12px;
        }
        .edit-toolbar button {
            padding: 3px 8px;
            cursor: pointer;
            background: var(--vscode-button-secondaryBackground, #3a3d41);
            color: var(--vscode-button-secondaryForeground, #ccc);
            border: 1px solid transparent;
            border-radius: 2px;
            font-size: 12px;
        }
        .edit-toolbar button:hover {
            background: var(--vscode-button-secondaryHoverBackground, #454a50);
        }
        .edit-toolbar button.active {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border-color: var(--vscode-focusBorder);
        }
        .edit-toolbar label {
            opacity: 0.8;
            display: flex;
            align-items: center;
            gap: 3px;
        }
        .edit-toolbar input[type="number"] {
            width: 42px;
            padding: 2px 4px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border, #3a3d41);
            border-radius: 2px;
            font-size: 12px;
        }
        #hover-info {
            font-size: 11px;
            opacity: 0.7;
            margin-left: 4px;
            min-width: 140px;
        }
    </style>
</head>
<body>
    <div id="initial-data" style="display:none" data-terrain="${escapedTerrain}" data-program="${escapedProgram}"></div>
    <div class="toolbar">
        <button id="btn-run" title="Run">&#9654; Run</button>
        <button id="btn-step" title="Step">&#9193; Step</button>
        <button id="btn-stop" title="Stop">&#9209; Stop</button>
        <button id="btn-reset" title="Reset">&#8634; Reset</button>
        <div class="speed-control">
            <label for="speed">Speed:</label>
            <input type="range" id="speed" min="50" max="1000" value="400" step="50">
        </div>
    </div>
    <div class="edit-toolbar">
        <label>W <input type="number" id="ter-w" value="10" min="1" max="30"></label>
        <label>H <input type="number" id="ter-h" value="8" min="1" max="20"></label>
        <button id="btn-new-terrain">New</button>
        <span style="opacity:0.4;margin:0 2px">|</span>
        <button class="active" data-tool="wall">Wall</button>
        <button data-tool="erase">Erase</button>
        <button data-tool="corn">Corn</button>
        <button data-tool="hamster">Move</button>
        <button data-tool="rotate">Rotate</button>
        <label>Corn <input type="number" id="corn-amount" value="1" min="0"></label>
        <span id="hover-info">Row -, Col -</span>
    </div>
    <div id="canvas-container">
        <canvas id="terrain" width="480" height="384"></canvas>
    </div>
    <div id="status">Loading...</div>
    <div id="log"></div>

    <script nonce="${nonce}">
    (function() {
        const vscode = acquireVsCodeApi();
        const canvas = document.getElementById('terrain');
        const ctx = canvas.getContext('2d');
        const logEl = document.getElementById('log');
        const statusEl = document.getElementById('status');
        const speedInput = document.getElementById('speed');

        const CELL = 48;
        const COLORS = ['#f5c518','#e74c3c','#2ecc71','#3498db','#9b59b6','#e67e22'];
        const DIRS = ['\\u2191','\\u2192','\\u2193','\\u2190'];
        const DX = [0, 1, 0, -1];
        const DY = [-1, 0, 1, 0];

        const spriteNames = ['hamsternorth.png','hamstereast.png','hamstersouth.png','hamsterwest.png'];
        const sprites = spriteNames.map(name => {
            const img = new Image();
            img.src = '${assetsUri}/' + name;
            img.onload = () => { if (engineState) render(engineState); };
            return img;
        });

        let engineState = null;
        let snapshot = null;
        let nextId = 0;
        let pendingInput = null;
        let runTimerId = null;
        let runnerState = null;
        let currentSource = '';

        const clone = obj => JSON.parse(JSON.stringify(obj));

        function makeTerrain(w, h) {
            return {
                width: w, height: h,
                walls: Array.from({length: h}, () => Array(w).fill(0)),
                corn:  Array.from({length: h}, () => Array(w).fill(0)),
                hamsters: [{id: -1, x: 0, y: 0, dir: 1, mouth: 0, color: 0}],
            };
        }

        function initEngine(w, h) {
            console.log('[DBG] initEngine', w, h);
            engineState = {
                state: 0,
                terrain: makeTerrain(Math.max(1,w|0), Math.max(1,h|0)),
                log: [],
                terminal: {needsInput:false, prompt:'', output:[]},
            };
            snapshot = null; nextId = 0;
            render(engineState);
            console.log('[DBG] initEngine done, canvas size:', canvas.width, canvas.height);
            return engineState;
        }

        function inside(x, y) {
            return x >= 0 && y >= 0 && y < engineState.terrain.height && x < engineState.terrain.width;
        }
        function isWall(x, y) {
            return !inside(x, y) || engineState.terrain.walls[y][x] === 1;
        }
        function getHamster(id) {
            const h = engineState.terrain.hamsters.find(x => x.id === id);
            if (!h) throw new Error('Hamster not initialised');
            return h;
        }
        function engineLog(msg) {
            engineState.log.push(msg);
            if (engineState.log.length > 200) engineState.log = engineState.log.slice(-200);
        }

        const engine = {
            init: (w,h) => initEngine(w,h),
            loadTerrain(terString) {
                const lines = String(terString).split(/\\r?\\n/);
                const w = parseInt(lines[0],10), h = parseInt(lines[1],10);
                initEngine(w, h);
                const cornCells = [];
                for (let row=0; row<h; row++) {
                    const line = lines[row+2]||'';
                    for (let col=0; col<w; col++) {
                        const c = line[col]||' ';
                        if (c==='#') engineState.terrain.walls[row][col]=1;
                        if (c==='*'||c==='^'||c==='>'||c==='v'||c==='<') cornCells.push([row,col]);
                        if (c==='^'||c==='>'||c==='v'||c==='<') {
                            const dir = c==='^'?0:c==='>'?1:c==='v'?2:3;
                            const def = getHamster(-1);
                            def.x=col; def.y=row; def.dir=dir;
                        }
                    }
                }
                const base = 2+h;
                for (let i=0; i<cornCells.length; i++) {
                    const [row,col]=cornCells[i];
                    const val=parseInt(lines[base+i]||'0',10);
                    engineState.terrain.corn[row][col]=isNaN(val)?0:val;
                }
                const mouthLine = base+cornCells.length;
                const mouth = parseInt(lines[mouthLine]||'0',10);
                getHamster(-1).mouth = isNaN(mouth)?0:mouth;
                render(engineState);
                return clone(engineState);
            },
            start() { snapshot=clone(engineState); engineState.state=1; return clone(engineState); },
            reset() { if(snapshot) engineState=clone(snapshot); engineState.state=0; render(engineState); return clone(engineState); },
            vor(id=-1) {
                const h=getHamster(id); const nx=h.x+DX[h.dir], ny=h.y+DY[h.dir];
                if(isWall(nx,ny)) throw new Error('Wall at row='+ny+', col='+nx);
                h.x=nx; h.y=ny; engineLog('[H'+id+'] vor()'); return clone(engineState);
            },
            linksUm(id=-1) { const h=getHamster(id); h.dir=(h.dir+3)%4; engineLog('[H'+id+'] linksUm()'); return clone(engineState); },
            nimm(id=-1) {
                const h=getHamster(id); const c=engineState.terrain.corn[h.y][h.x];
                if(c<=0) throw new Error('No grain at row='+h.y+', col='+h.x);
                engineState.terrain.corn[h.y][h.x]=c-1; h.mouth+=1; engineLog('[H'+id+'] nimm()'); return clone(engineState);
            },
            gib(id=-1) {
                const h=getHamster(id); if(h.mouth<=0) throw new Error('Hamster mouth is empty');
                engineState.terrain.corn[h.y][h.x]+=1; h.mouth-=1; engineLog('[H'+id+'] gib()'); return clone(engineState);
            },
            vornFrei(id=-1) { const h=getHamster(id); return !isWall(h.x+DX[h.dir], h.y+DY[h.dir]); },
            kornDa(id=-1) { return engineState.terrain.corn[getHamster(id).y][getHamster(id).x]>0; },
            maulLeer(id=-1) { return getHamster(id).mouth===0; },
            getReihe(id=-1) { return getHamster(id).y; },
            getSpalte(id=-1) { return getHamster(id).x; },
            getBlickrichtung(id=-1) { return getHamster(id).dir; },
            getAnzahlKoerner(id=-1) { return getHamster(id).mouth; },
            createHamster(row,col,dir,mouth,color=1) {
                if(isWall(col,row)) throw new Error('Wall at spawn position');
                const id=nextId++; engineState.terrain.hamsters.push({id,x:col,y:row,dir,mouth,color}); return id;
            },
            getState() { return clone(engineState); },
            provideInput(val) { pendingInput=String(val); engineState.terminal.needsInput=false; engineState.terminal.prompt=''; engineState.terminal.output.push(String(val)); },
            readInt(_hid=-1,prompt='') {
                if(pendingInput!=null) { const v=pendingInput; pendingInput=null; const n=parseInt(v,10); return Number.isNaN(n)?0:n; }
                engineState.terminal.needsInput=true; engineState.terminal.prompt=String(prompt||'Enter number:'); return 0;
            },
            readString(_hid=-1,prompt='') {
                if(pendingInput!=null) { const v=pendingInput; pendingInput=null; return v; }
                engineState.terminal.needsInput=true; engineState.terminal.prompt=String(prompt||'Enter text:'); return '';
            },
            setWall(col,row,value) {
                if(inside(col,row)) engineState.terrain.walls[row][col]=value?1:0;
                return clone(engineState);
            },
            setCorn(col,row,count) {
                if(inside(col,row)) engineState.terrain.corn[row][col]=Math.max(0,count|0);
                return clone(engineState);
            },
            setDefaultHamster(col,row,dir) {
                if(!inside(col,row)) throw new Error('Position outside terrain');
                if(engineState.terrain.walls[row][col]) throw new Error('Cannot place hamster on a wall');
                const h=getHamster(-1); h.x=col; h.y=row;
                if(dir!=null && !Number.isNaN(dir)) h.dir=((dir%4)+4)%4;
                return clone(engineState);
            },
            rotateDefaultHamster(turns) {
                const h=getHamster(-1); const d=(turns|0); h.dir=((h.dir+d)%4+4)%4;
                return clone(engineState);
            },
        };

        // ── Canvas renderer ──
        function render(state) {
            if (!state) return;
            const {terrain} = state;
            const {width,height,walls,corn,hamsters} = terrain;
            canvas.width = width*CELL; canvas.height = height*CELL;

            ctx.fillStyle='#f9f5e7'; ctx.fillRect(0,0,canvas.width,canvas.height);
            ctx.strokeStyle='#ccc'; ctx.lineWidth=1;
            for(let x=0;x<=width;x++){ctx.beginPath();ctx.moveTo(x*CELL,0);ctx.lineTo(x*CELL,height*CELL);ctx.stroke();}
            for(let y=0;y<=height;y++){ctx.beginPath();ctx.moveTo(0,y*CELL);ctx.lineTo(width*CELL,y*CELL);ctx.stroke();}

            for(let row=0;row<height;row++) for(let col=0;col<width;col++){
                const px=col*CELL, py=row*CELL;
                if(walls[row][col]) { ctx.fillStyle='#555'; ctx.fillRect(px+1,py+1,CELL-2,CELL-2); }
                else {
                    const c=corn[row][col];
                    if(c>0) {
                        ctx.fillStyle='#27ae60'; ctx.beginPath(); ctx.arc(px+CELL/2,py+CELL/2,CELL*0.22,0,Math.PI*2); ctx.fill();
                        ctx.fillStyle='#fff'; ctx.font='bold '+(CELL*0.28)+'px sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
                        ctx.fillText(c,px+CELL/2,py+CELL/2);
                    }
                }
            }
            for(const h of hamsters) drawHamster(h);
        }

        function drawHamster(h) {
            const dir=((h.dir%4)+4)%4;
            const sprite=sprites[dir];
            if(sprite && sprite.complete && sprite.naturalWidth>0) {
                const x=h.x*CELL, y=h.y*CELL, pad=Math.max(2,Math.floor(CELL*0.08));
                ctx.drawImage(sprite,x+pad,y+pad,CELL-pad*2,CELL-pad*2);
                if(h.mouth>0) {
                    const bx=x+CELL*0.78, by=y+CELL*0.22;
                    ctx.fillStyle='#e74c3c'; ctx.beginPath(); ctx.arc(bx,by,CELL*0.16,0,Math.PI*2); ctx.fill();
                    ctx.fillStyle='#fff'; ctx.font='bold '+(CELL*0.2)+'px sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle'; ctx.fillText(h.mouth,bx,by);
                }
                return;
            }
            const px=h.x*CELL+CELL/2, py=h.y*CELL+CELL/2, r=CELL*0.36;
            const color=COLORS[h.color%COLORS.length];
            ctx.fillStyle=color; ctx.beginPath(); ctx.arc(px,py,r,0,Math.PI*2); ctx.fill();
            ctx.fillStyle='rgba(0,0,0,0.7)'; ctx.font='bold '+(CELL*0.4)+'px sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle'; ctx.fillText(DIRS[dir],px,py);
            if(h.mouth>0) {
                ctx.fillStyle='#e74c3c'; ctx.beginPath(); ctx.arc(px+r*0.7,py-r*0.7,CELL*0.18,0,Math.PI*2); ctx.fill();
                ctx.fillStyle='#fff'; ctx.font='bold '+(CELL*0.22)+'px sans-serif'; ctx.fillText(h.mouth,px+r*0.7,py-r*0.7);
            }
        }

        function appendLog(text, isError) {
            const div = document.createElement('div');
            div.textContent = text;
            if (isError) div.className = 'log-error';
            logEl.appendChild(div);
            logEl.scrollTop = logEl.scrollHeight;
        }
        function clearLog() { logEl.innerHTML = ''; }

        // Init terrain – use embedded data if provided, else default 10x8
        const initialDataEl = document.getElementById('initial-data');
        const initialTerrain = initialDataEl ? initialDataEl.getAttribute('data-terrain') : null;
        const initialProgram = initialDataEl ? initialDataEl.getAttribute('data-program') : null;
        if (initialTerrain) {
            try { engine.loadTerrain(initialTerrain); }
            catch(e) { initEngine(10, 8); }
        } else {
            initEngine(10, 8);
        }
        if (initialProgram) {
            currentSource = initialProgram;
        }

        // ── Message handling from extension host ──
        window.addEventListener('message', event => {
            const msg = event.data;
            switch(msg.type) {
                case 'loadProgram':
                    currentSource = msg.source;
                    statusEl.textContent = 'Program loaded';
                    break;
                case 'loadTerrain':
                    doStop();
                    try {
                        engine.loadTerrain(msg.terrain);
                        statusEl.textContent = 'Terrain loaded';
                    } catch(e) {
                        statusEl.textContent = 'Terrain error: ' + (e.message||e);
                        console.error('loadTerrain failed:', e, 'input:', JSON.stringify(msg.terrain).substring(0,200));
                    }
                    break;
                case 'command':
                    handleCommand(msg.command);
                    break;
            }
        });

        document.getElementById('btn-run').addEventListener('click', () => handleCommand('run'));
        document.getElementById('btn-step').addEventListener('click', () => handleCommand('step'));
        document.getElementById('btn-stop').addEventListener('click', () => handleCommand('stop'));
        document.getElementById('btn-reset').addEventListener('click', () => handleCommand('reset'));

        function handleCommand(cmd) {
            switch(cmd) {
                case 'run': doRun(); break;
                case 'step': doStep(); break;
                case 'stop': doStop(); break;
                case 'reset': doReset(); break;
            }
        }

        function doRun() {
            if (runTimerId !== null) return;
            if (!runnerState || runnerState.finished) {
                if (!compileProgram()) return;
            }
            engine.start();
            statusEl.textContent = 'Running...';
            function tick() {
                const hasMore = doStepInternal();
                if (hasMore) {
                    runTimerId = setTimeout(tick, parseInt(speedInput.value));
                } else {
                    runTimerId = null;
                    statusEl.textContent = 'Finished';
                }
            }
            tick();
        }

        function doStep() {
            if (!runnerState || runnerState.finished) {
                if (!compileProgram()) return;
                engine.start();
            }
            const hasMore = doStepInternal();
            statusEl.textContent = hasMore ? 'Stepped' : 'Finished';
        }

        function doStop() {
            if (runTimerId !== null) { clearTimeout(runTimerId); runTimerId = null; }
            statusEl.textContent = 'Stopped';
        }

        function doReset() {
            doStop();
            runnerState = null;
            engine.reset();
            clearLog();
            vscode.postMessage({type:'clearHighlight'});
            statusEl.textContent = 'Reset';
        }

        function compileProgram() {
            if (!currentSource) {
                vscode.postMessage({type:'error', message:'No program loaded. Open a .ham file first.'});
                return false;
            }
            if (!window.parseProgram) {
                vscode.postMessage({type:'error', message:'Language tools not loaded yet.'});
                return false;
            }
            runnerState = null;
            clearLog();
            try {
                const ast = window.parseProgram(currentSource, {compatibility:true, requireMain:true});
                runnerState = window.createRunnerState(ast, createRuntime());
                return true;
            } catch(e) {
                appendLog('Compile error: ' + (e.message||e), true);
                statusEl.textContent = 'Compile error';
                return false;
            }
        }

        function doStepInternal() {
            if (!runnerState || runnerState.finished) return false;
            try {
                const progressed = window.executeRunnerStep(runnerState);
                render(engineState);
                if (engineState.log.length > 0) {
                    appendLog(engineState.log[engineState.log.length-1]);
                }
                // Send current line to extension for editor highlighting
                const loc = runnerState.lastInstruction?.loc;
                if (loc && loc.line) {
                    vscode.postMessage({type:'highlightLine', line: loc.line});
                }
                if (!progressed) {
                    runnerState.finished = true;
                    vscode.postMessage({type:'clearHighlight'});
                    return false;
                }
                return !runnerState.finished;
            } catch(e) {
                if (window.RunnerPause && e instanceof window.RunnerPause) {
                    render(engineState);
                    return true;
                }
                appendLog('Runtime error: '+(e.message||e), true);
                runnerState.finished = true;
                vscode.postMessage({type:'clearHighlight'});
                render(engineState);
                return false;
            }
        }

        function defaultHamsterId(args) {
            if(!args||args.length===0) return -1;
            const first=args[0];
            if(first && typeof first==='object' && first.__kind==='hamster') return Number(first.id);
            return Number(first);
        }

        function createRuntime() {
            return {
                resolveIdentifier(name) {
                    if (name==='Hamster') return {__kind:'class',name:'Hamster'};
                    if (/^[A-Z][A-Za-z0-9_]*$/.test(name)) return {__kind:'class',name};
                    return undefined;
                },
                createObject(className, args) {
                    if (className.endsWith('Hamster')) {
                        if (args.length<4) throw new Error(className+' constructor expects at least 4 arguments');
                        const id = engine.createHamster(Number(args[0]),Number(args[1]),Number(args[2]),Number(args[3]),args.length>=5?Number(args[4]):1);
                        return {__kind:'hamster',id,className};
                    }
                    return {__kind:'object',className,fields:Object.create(null)};
                },
                getMember(receiver, property) {
                    if (receiver && receiver.__kind==='class' && receiver.name==='Hamster') {
                        if (property==='NORD') return 0;
                        if (property==='OST') return 1;
                        if (property==='SUED') return 2;
                        if (property==='WEST') return 3;
                    }
                    if (receiver && receiver.__kind==='object') return receiver.fields[property];
                    return undefined;
                },
                setMember(receiver, property, value) {
                    if (receiver && receiver.__kind==='object') { receiver.fields[property]=value; return true; }
                    return false;
                },
                callMethod(receiver, methodName, args) {
                    if (receiver && receiver.__kind==='hamster') {
                        const hid=receiver.id;
                        switch(methodName){
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
                            case 'schreib': appendLog(String(args.length>0?args[0]:'')); return undefined;
                        }
                    }
                    if (receiver && receiver.__kind==='class') return this.callBuiltin(receiver.name+'.'+methodName, args);
                    if (typeof receiver==='string') {
                        if (methodName==='equals') return receiver===String(args?.[0]??'');
                        if (methodName==='equalsIgnoreCase') return receiver.toLowerCase()===String(args?.[0]??'').toLowerCase();
                        if (methodName==='length') return receiver.length;
                    }
                    throw new Error('Unsupported method call: '+methodName);
                },
                callBuiltin(name, args) {
                    if (name==='Math.random') return Math.random();
                    if (name.endsWith('.getStandardHamster')||name.endsWith('.getStandardHamsterAlsDrehHamster'))
                        return {__kind:'hamster',id:-1,className:'Hamster'};
                    switch(name){
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
                            if(args.length<4) throw new Error('createHamster expects at least 4 arguments');
                            return engine.createHamster(Number(args[0]),Number(args[1]),Number(args[2]),Number(args[3]),args.length>=5?Number(args[4]):1);
                        case 'schreib': appendLog(String(args.length>0?args[0]:'')); return undefined;
                        default: throw new Error('Unknown function: '+name);
                    }
                },
            };
        }

        // ── Terrain editor ──
        let currentTool = 'wall';
        let isDragging = false;
        let lastPaintCell = null;
        const toolButtons = document.querySelectorAll('[data-tool]');
        const cornInput = document.getElementById('corn-amount');
        const hoverInfo = document.getElementById('hover-info');

        toolButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                currentTool = btn.dataset.tool;
                toolButtons.forEach(b => b.classList.toggle('active', b === btn));
            });
        });

        document.getElementById('btn-new-terrain').addEventListener('click', () => {
            const w = parseInt(document.getElementById('ter-w').value, 10);
            const h = parseInt(document.getElementById('ter-h').value, 10);
            if (isNaN(w)||isNaN(h)||w<1||h<1) return;
            initEngine(w, h);
            clearLog();
            runnerState = null;
            statusEl.textContent = 'New terrain ' + w + '\\u00d7' + h;
        });

        function eventToCell(evt) {
            if (!engineState) return null;
            const t = engineState.terrain;
            const rect = canvas.getBoundingClientRect();
            const px = (evt.clientX - rect.left) * (canvas.width / rect.width);
            const py = (evt.clientY - rect.top) * (canvas.height / rect.height);
            const cw = t.width ? canvas.width / t.width : 1;
            const ch = t.height ? canvas.height / t.height : 1;
            const x = Math.floor(px / cw);
            const y = Math.floor(py / ch);
            if (x<0||y<0||x>=t.width||y>=t.height) return null;
            return {x, y};
        }

        function updateHover(cell) {
            if (!hoverInfo) return;
            if (!cell||!engineState) { hoverInfo.textContent='Row -, Col -'; return; }
            const t = engineState.terrain;
            const w = t.walls[cell.y][cell.x]===1;
            const c = t.corn[cell.y][cell.x];
            const h = t.hamsters.find(h => h.x===cell.x && h.y===cell.y);
            const p = ['Row '+cell.y, 'Col '+cell.x];
            p.push(w?'Wall':'Free');
            if(c>0) p.push(c+' corn');
            if(h) p.push('Hamster');
            hoverInfo.textContent = p.join(' \\u00b7 ');
        }

        function getCornAmount() {
            const v = parseInt(cornInput?.value??'0',10);
            return Number.isNaN(v)?0:Math.max(0,v);
        }

        function applyTool(cell) {
            if (runTimerId!==null||!engineState) return;
            let s = null;
            try {
                switch(currentTool) {
                    case 'wall':
                        if(!cell) return;
                        s = engine.setWall(cell.x,cell.y,1); break;
                    case 'erase':
                        if(!cell) return;
                        engine.setWall(cell.x,cell.y,0);
                        s = engine.setCorn(cell.x,cell.y,0); break;
                    case 'corn':
                        if(!cell) return;
                        engine.setWall(cell.x,cell.y,0);
                        s = engine.setCorn(cell.x,cell.y,getCornAmount()); break;
                    case 'hamster':
                        if(!cell) return;
                        s = engine.setDefaultHamster(cell.x,cell.y); break;
                    case 'rotate':
                        s = engine.rotateDefaultHamster(1); break;
                }
            } catch(err) {
                statusEl.textContent = err.message||'Edit failed';
                return;
            }
            if(s) { render(engineState); lastPaintCell=cell||null; }
        }

        canvas.addEventListener('mousedown', evt => {
            const cell = eventToCell(evt);
            if(currentTool!=='rotate'&&!cell) return;
            isDragging=true; lastPaintCell=null;
            applyTool(cell);
        });
        canvas.addEventListener('mousemove', evt => {
            const cell = eventToCell(evt);
            updateHover(cell);
            if(!isDragging) return;
            if(currentTool!=='rotate'&&cell&&lastPaintCell&&lastPaintCell.x===cell.x&&lastPaintCell.y===cell.y) return;
            applyTool(cell);
        });
        canvas.addEventListener('mouseleave', () => { updateHover(null); isDragging=false; lastPaintCell=null; });
        window.addEventListener('mouseup', () => { isDragging=false; lastPaintCell=null; });
    })();
    </script>

    <!-- Inlined language tools (lexer → parser → runner, single block so declarations are shared) -->
    <script nonce="${nonce}">
    // --- hamster-lexer.js ---
    ${lexerCode}
    // --- hamster-parser.js ---
    ${parserCode}
    // --- hamster-runner.js ---
    ${runnerCode}
    // Expose to the main script
    window.parseProgram = parseProgram;
    window.RunnerPause = RunnerPause;
    window.createRunnerState = createRunnerState;
    window.executeRunnerStep = executeRunnerStep;
    document.getElementById('status').textContent = 'Ready \u2013 open a .ham file and click Run';
    </script>
</body>
</html>`;
    }

    dispose() {
        this.panel.dispose();
    }

    private cleanUp() {
        while (this.disposables.length) {
            this.disposables.pop()?.dispose();
        }
    }
}

const stepHighlight = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
    isWholeLine: true,
});
