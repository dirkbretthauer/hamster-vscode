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

module.exports = function (env, argv) {
	webExtensionConfig.mode = argv.mode || 'none';
	return webExtensionConfig;
};
