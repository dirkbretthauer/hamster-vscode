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

module.exports = function (env, argv) {
	webExtensionConfig.mode = argv.mode || 'none';
	webviewLangConfig.mode = argv.mode || 'none';
	return [webExtensionConfig, webviewLangConfig];
};
