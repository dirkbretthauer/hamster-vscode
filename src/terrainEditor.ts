import * as vscode from 'vscode';
import * as path from 'path';
import { getNonce } from './utils';

export class TerrainEditorProvider implements vscode.CustomTextEditorProvider {
    public static readonly viewType = 'hamster.terrainEditor';

    constructor(private readonly context: vscode.ExtensionContext) {}

    public async resolveCustomTextEditor(
        document: vscode.TextDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken,
    ): Promise<void> {
        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.file(path.join(this.context.extensionPath, 'assets')),
            ],
        };

        const assetsUri = webviewPanel.webview.asWebviewUri(
            vscode.Uri.file(path.join(this.context.extensionPath, 'assets'))
        );

        const escapedTerrain = document.getText()
            .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

        const nonce = getNonce();

        webviewPanel.webview.html = this.getHtml(
            webviewPanel.webview, nonce, assetsUri.toString(),
            escapedTerrain,
        );

        // Track the last content we sent to the document to prevent circular updates
        let lastWebviewContent = '';

        webviewPanel.webview.onDidReceiveMessage(async msg => {
            if (msg.type === 'terrainChanged') {
                lastWebviewContent = msg.content;
                await this.updateDocument(document, msg.content);
            }
        });

        // When the document changes externally (e.g. git, undo), reload in the webview
        const changeSubscription = vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document.uri.toString() !== document.uri.toString() || e.contentChanges.length === 0) return;
            const currentText = document.getText();
            if (currentText === lastWebviewContent) return;
            webviewPanel.webview.postMessage({
                type: 'loadTerrain',
                terrain: currentText,
            });
        });
        webviewPanel.onDidDispose(() => changeSubscription.dispose());
    }

    private async updateDocument(document: vscode.TextDocument, content: string) {
        const edit = new vscode.WorkspaceEdit();
        const fullRange = new vscode.Range(
            new vscode.Position(0, 0),
            document.lineAt(document.lineCount - 1).range.end,
        );
        edit.replace(document.uri, fullRange, content);
        await vscode.workspace.applyEdit(edit);
    }

    private getHtml(
        webview: vscode.Webview, nonce: string, assetsUri: string,
        escapedTerrain: string,
    ): string {
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
    <title>Terrain Editor</title>
    <style>
        body {
            margin: 0; padding: 8px;
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
        }
        .edit-toolbar {
            display: flex; gap: 4px; margin-bottom: 8px;
            flex-wrap: wrap; align-items: center; font-size: 12px;
        }
        .edit-toolbar button {
            padding: 3px 8px; cursor: pointer;
            background: var(--vscode-button-secondaryBackground, #3a3d41);
            color: var(--vscode-button-secondaryForeground, #ccc);
            border: 1px solid transparent; border-radius: 2px; font-size: 12px;
        }
        .edit-toolbar button:hover { background: var(--vscode-button-secondaryHoverBackground, #454a50); }
        .edit-toolbar button.active {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border-color: var(--vscode-focusBorder);
        }
        .edit-toolbar label { opacity: 0.8; display: flex; align-items: center; gap: 3px; }
        .edit-toolbar input[type="number"] {
            width: 42px; padding: 2px 4px;
            background: var(--vscode-input-background); color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border, #3a3d41); border-radius: 2px; font-size: 12px;
        }
        #hover-info { font-size: 11px; opacity: 0.7; margin-left: 4px; min-width: 140px; }
        #canvas-container {
            border: 1px solid var(--vscode-panel-border);
            background: #f9f5e7; display: inline-block;
        }
        canvas { display: block; }
    </style>
</head>
<body>
    <div id="initial-data" style="display:none" data-terrain="${escapedTerrain}"></div>
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

    <script nonce="${nonce}">
    (function() {
        const vscode = acquireVsCodeApi();
        const canvas = document.getElementById('terrain');
        const ctx = canvas.getContext('2d');

        const CELL = 48;
        const COLORS = ['#f5c518','#e74c3c','#2ecc71','#3498db','#9b59b6','#e67e22'];
        const DIRS = ['\\u2191','\\u2192','\\u2193','\\u2190'];
        const DIR_TO_TER = ['^','>','v','<'];
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
        let nextId = 0;
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
            engineState = {
                state: 0,
                terrain: makeTerrain(Math.max(1,w|0), Math.max(1,h|0)),
                log: [], terminal: {needsInput:false, prompt:'', output:[]},
            };
            nextId = 0;
            render(engineState);
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

        const engine = {
            loadTerrain(terString) {
                const lines = String(terString).split(/\\r?\\n/);
                const w = parseInt(lines[0],10), h = parseInt(lines[1],10);
                if (isNaN(w)||isNaN(h)||w<1||h<1) { initEngine(10,8); return; }
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
            },
            setWall(col,row,value) {
                if(inside(col,row)) engineState.terrain.walls[row][col]=value?1:0;
            },
            setCorn(col,row,count) {
                if(inside(col,row)) engineState.terrain.corn[row][col]=Math.max(0,count|0);
            },
            setDefaultHamster(col,row) {
                if(!inside(col,row)) throw new Error('Outside terrain');
                if(engineState.terrain.walls[row][col]) throw new Error('Cannot place on wall');
                const h=getHamster(-1); h.x=col; h.y=row;
            },
            rotateDefaultHamster(turns) {
                const h=getHamster(-1); h.dir=((h.dir+(turns|0))%4+4)%4;
            },
        };

        // ── Renderer ──
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
            ctx.fillStyle=COLORS[h.color%COLORS.length];
            ctx.beginPath(); ctx.arc(px,py,r,0,Math.PI*2); ctx.fill();
            ctx.fillStyle='rgba(0,0,0,0.7)'; ctx.font='bold '+(CELL*0.4)+'px sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle'; ctx.fillText(DIRS[dir],px,py);
            if(h.mouth>0) {
                ctx.fillStyle='#e74c3c'; ctx.beginPath(); ctx.arc(px+r*0.7,py-r*0.7,CELL*0.18,0,Math.PI*2); ctx.fill();
                ctx.fillStyle='#fff'; ctx.font='bold '+(CELL*0.22)+'px sans-serif'; ctx.fillText(h.mouth,px+r*0.7,py-r*0.7);
            }
        }

        // ── Serialize ──
        function terrainToTer() {
            if (!engineState) return '';
            const t = engineState.terrain;
            const def = t.hamsters.find(h => h.id===-1) || {x:0,y:0,dir:1,mouth:0};
            const lines = [];
            const cornPos = [];
            for (let row=0; row<t.height; row++) {
                let line='';
                for (let col=0; col<t.width; col++) {
                    if (t.walls[row][col]) { line+='#'; continue; }
                    const isDef = def.x===col && def.y===row;
                    const c = t.corn[row][col]||0;
                    if (isDef) { line+=DIR_TO_TER[((def.dir%4)+4)%4]||'>'; cornPos.push({x:col,y:row}); }
                    else if (c>0) { line+='*'; cornPos.push({x:col,y:row}); }
                    else { line+=' '; }
                }
                lines.push(line);
            }
            return [String(t.width), String(t.height), ...lines,
                ...cornPos.map(p => String(t.corn[p.y][p.x]||0)),
                String(def.mouth||0)].join('\\n');
        }

        function notifyChanged() {
            vscode.postMessage({type:'terrainChanged', content: terrainToTer()});
        }

        // ── Init from embedded data ──
        const initialDataEl = document.getElementById('initial-data');
        const initialTerrain = initialDataEl ? initialDataEl.getAttribute('data-terrain') : null;
        if (initialTerrain) {
            try { engine.loadTerrain(initialTerrain); } catch(e) { initEngine(10, 8); }
        } else {
            initEngine(10, 8);
        }

        // ── External document changes ──
        window.addEventListener('message', event => {
            if (event.data.type === 'loadTerrain') {
                engine.loadTerrain(event.data.terrain);
            }
        });

        // ── Terrain editing ──
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
            notifyChanged();
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
            let changed = false;
            try {
                switch(currentTool) {
                    case 'wall':
                        if(!cell) return; engine.setWall(cell.x,cell.y,1); changed=true; break;
                    case 'erase':
                        if(!cell) return; engine.setWall(cell.x,cell.y,0); engine.setCorn(cell.x,cell.y,0); changed=true; break;
                    case 'corn':
                        if(!cell) return; engine.setWall(cell.x,cell.y,0); engine.setCorn(cell.x,cell.y,getCornAmount()); changed=true; break;
                    case 'hamster':
                        if(!cell) return; engine.setDefaultHamster(cell.x,cell.y); changed=true; break;
                    case 'rotate':
                        engine.rotateDefaultHamster(1); changed=true; break;
                }
            } catch(err) { return; }
            if(changed) { render(engineState); lastPaintCell=cell||null; notifyChanged(); }
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
</body>
</html>`;
    }
}
