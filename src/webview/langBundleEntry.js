/**
 * Webpack entry bundled into `dist/webview/hamster-lang.js` and loaded by the
 * simulator and terrain editor webviews via a `<script src>` tag.
 *
 * Replaces the previous approach of reading `lang/*.js` as raw text and
 * inlining a `stripEsModule()`-processed copy straight into the webview HTML.
 * This bundles the real ES modules with webpack instead, then republishes
 * every export as a global so the webviews' existing bootstrap scripts can
 * keep calling them as bare identifiers (`parseProgram(...)`,
 * `parseTerrainFile(...)`, etc.) without any call-site changes.
 */
import * as lexer from '../../lang/hamster-lexer.js';
import * as parser from '../../lang/hamster-parser.js';
import * as runner from '../../lang/hamster-runner.js';
import * as terrain from '../../lang/hamster-terrain.js';
import * as scheduler from '../../lang/hamster-scheduler.js';

Object.assign(window, lexer, parser, runner, terrain, scheduler);
