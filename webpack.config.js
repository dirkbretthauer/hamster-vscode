/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//@ts-check
'use strict';

const path = require('path');

/**@type {import('webpack').Configuration}*/
const webExtensionConfig = {
	mode: 'none',
	target: 'webworker',
	entry: './src/extension.ts',
	output: {
		path: path.resolve(__dirname, 'dist', 'web'),
		filename: 'extension.js',
		libraryTarget: 'commonjs'
	},
	externals: {
		vscode: 'commonjs vscode'
	},
	resolve: {
		extensions: ['.ts', '.js']
	},
	module: {
		parser: {
			javascript: {
				exportsPresence: 'error'
			}
		},
		rules: [
			{
				test: /\.ts$/,
				exclude: /node_modules/,
				use: [
					{
						loader: 'ts-loader'
					}
				]
			}
		]
	},
	devtool: 'nosources-source-map'
};

const nodeExtensionConfig = {
	...webExtensionConfig,
	target: 'node',
	output: {
		...webExtensionConfig.output,
		path: path.resolve(__dirname, 'dist'),
		libraryTarget: 'commonjs2'
	}
};

/**
 * Bundles the shared `lang/*.js` language tools for the webviews (simulator
 * and terrain editor) as real ES modules, instead of inlining raw
 * `stripEsModule()`-processed source directly into the webview HTML.
 * @type {import('webpack').Configuration}
 */
const webviewLangConfig = {
	mode: 'none',
	target: 'web',
	entry: './src/webview/langBundleEntry.js',
	output: {
		path: path.resolve(__dirname, 'dist', 'webview'),
		filename: 'hamster-lang.js'
	},
	resolve: {
		extensions: ['.js']
	},
	devtool: 'nosources-source-map'
};

/**
 * Bundles the simulator webview's engine/runtime/debugger/renderer/bootstrap
 * modules (`src/webview/simulator/`) into one script loaded by
 * `hamsterPanel.ts`'s webview, replacing the previous giant inline
 * `<script>` block.
 * @type {import('webpack').Configuration}
 */
const webviewSimulatorConfig = {
	mode: 'none',
	target: 'web',
	entry: './src/webview/simulator/index.js',
	output: {
		path: path.resolve(__dirname, 'dist', 'webview'),
		filename: 'hamster-simulator.js'
	},
	resolve: {
		extensions: ['.js']
	},
	devtool: 'nosources-source-map'
};

/**
 * Bundles the terrain editor webview's engine/renderer/bootstrap modules
 * (`src/webview/terrainEditor/`) into one script loaded by
 * `terrainEditor.ts`'s webview, replacing its previous inline `<script>`
 * block.
 * @type {import('webpack').Configuration}
 */
const webviewTerrainEditorConfig = {
	mode: 'none',
	target: 'web',
	entry: './src/webview/terrainEditor/index.js',
	output: {
		path: path.resolve(__dirname, 'dist', 'webview'),
		filename: 'hamster-terrain-editor.js'
	},
	resolve: {
		extensions: ['.js']
	},
	devtool: 'nosources-source-map'
};

module.exports = function (env, argv) {
	webExtensionConfig.mode = argv.mode || 'none';
	nodeExtensionConfig.mode = argv.mode || 'none';
	webviewLangConfig.mode = argv.mode || 'none';
	webviewSimulatorConfig.mode = argv.mode || 'none';
	webviewTerrainEditorConfig.mode = argv.mode || 'none';
	return [nodeExtensionConfig, webExtensionConfig, webviewLangConfig, webviewSimulatorConfig, webviewTerrainEditorConfig];
};
