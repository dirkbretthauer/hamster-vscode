// Simulate what HamsterPanel.getHtmlContent does
const fs = require('fs');
const path = require('path');

function stripEsModule(code) {
    return code
        .replace(/^export\s+(const|class|function)\s+/gm, '$1 ')
        .replace(/^export\s+\{[^}]*\};?\s*$/gm, '')
        .replace(/^import\s+.*$/gm, '');
}

const langDir = path.join(__dirname, 'lang');
const lexerCode = stripEsModule(fs.readFileSync(path.join(langDir, 'hamster-lexer.js'), 'utf-8'));
const parserCode = stripEsModule(fs.readFileSync(path.join(langDir, 'hamster-parser.js'), 'utf-8'));
const runnerCode = stripEsModule(fs.readFileSync(path.join(langDir, 'hamster-runner.js'), 'utf-8'));

// Check for </script> in any of the scripts
if (lexerCode.includes('</script>')) console.log('DANGER: lexer contains </script>');
if (parserCode.includes('</script>')) console.log('DANGER: parser contains </script>');
if (runnerCode.includes('</script>')) console.log('DANGER: runner contains </script>');

// Check total size
const combined = lexerCode + parserCode + runnerCode;
console.log('Total script size:', combined.length, 'bytes');
console.log('Lexer:', lexerCode.length, 'Parser:', parserCode.length, 'Runner:', runnerCode.length);

// Write a minimal test HTML to check
const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>Test</title></head>
<body>
<div id="initial-data" style="display:none" data-terrain="" data-program=""></div>
<canvas id="terrain" width="480" height="384"></canvas>
<div id="status">Loading...</div>
<div id="log"></div>
<script>
(function() {
    console.log('Script 1 start');
    const canvas = document.getElementById('terrain');
    const ctx = canvas.getContext('2d');
    
    const CELL = 48;
    
    function makeTerrain(w, h) {
        return {
            width: w, height: h,
            walls: Array.from({length: h}, () => Array(w).fill(0)),
            corn: Array.from({length: h}, () => Array(w).fill(0)),
            hamsters: [{id: -1, x: 0, y: 0, dir: 1, mouth: 0, color: 0}],
        };
    }
    
    let engineState = null;
    
    function initEngine(w, h) {
        engineState = {
            state: 0,
            terrain: makeTerrain(Math.max(1,w|0), Math.max(1,h|0)),
            log: [], terminal: {needsInput:false, prompt:'', output:[]},
        };
        render(engineState);
        return engineState;
    }
    
    function render(state) {
        if (!state) return;
        const {terrain} = state;
        const {width, height, walls} = terrain;
        canvas.width = width * CELL;
        canvas.height = height * CELL;
        ctx.fillStyle = '#f9f5e7';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.strokeStyle = '#ccc';
        ctx.lineWidth = 1;
        for(let x = 0; x <= width; x++) {
            ctx.beginPath(); ctx.moveTo(x*CELL, 0); ctx.lineTo(x*CELL, height*CELL); ctx.stroke();
        }
        for(let y = 0; y <= height; y++) {
            ctx.beginPath(); ctx.moveTo(0, y*CELL); ctx.lineTo(width*CELL, y*CELL); ctx.stroke();
        }
        console.log('Rendered', width, 'x', height, 'grid');
    }
    
    const initialDataEl = document.getElementById('initial-data');
    const initialTerrain = initialDataEl ? initialDataEl.getAttribute('data-terrain') : null;
    console.log('initialTerrain:', JSON.stringify(initialTerrain));
    if (initialTerrain) {
        console.log('Loading terrain from data');
    } else {
        console.log('Calling initEngine(10, 8)');
        initEngine(10, 8);
    }
    console.log('Script 1 end');
})();
</script>
<script>
${lexerCode}
${parserCode}
${runnerCode}
console.log('Script 2 done - parseProgram:', typeof parseProgram);
</script>
</body>
</html>`;

fs.writeFileSync(path.join(__dirname, '_test_output.html'), html);
console.log('Wrote _test_output.html');
