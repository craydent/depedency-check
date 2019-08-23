import * as vscode from 'vscode';
import { stat, readdir, readFile } from 'fs';
const $c = require('craydent');

// this method is called when vs code is activated
export async function activate(context: vscode.ExtensionContext) {
	const root = vscode.workspace.rootPath || '';
	const treeConfigPath = `${root}/.depcheck/cache.json`;
	let timeout: NodeJS.Timer | undefined = undefined;
	let filesProcessed = 0;
	let json: any = null;
	let dependencyTree: any = null;
	let activeEditor = vscode.window.activeTextEditor;

	const clearCache = async () => {
		await $c.unlink(treeConfigPath);
		dependencyTree = null;
		if (activeEditor) {
			activeEditor.setDecorations(unusedDeccorationType, []);
		}
	};
	const refreshCache = async () => { await clearCache(); triggerUpdateDecorations(true); };

	context.subscriptions.push(vscode.commands.registerCommand('depcheck.clearCache', clearCache));
	context.subscriptions.push(vscode.commands.registerCommand('depcheck.refreshCache', refreshCache));

	// create a decorator type
	const unusedDeccorationType = vscode.window.createTextEditorDecorationType({
		color: 'grey',
		overviewRulerLane: vscode.OverviewRulerLane.Right
	});


	function onDidChangeActiveTextEditor(editor: vscode.TextEditor | undefined) {
		activeEditor = editor;
		if (editor) {
			triggerUpdateDecorations();
		}
	}

	function onDidChangeTextDocument(event: vscode.TextDocumentChangeEvent) {
		if (!dependencyTree) { return; }
		if (activeEditor && event.document === activeEditor.document) {
			const filename = $c.replace_all(event.document.fileName.replace(root, ''), '\\', '/');

			if (/package\.json$/.test(filename)) {
				json = $c.include(event.document.fileName) || json;
				return;
			}
			if (!filename.endsWithAny(['.js', '.jsx', '.ts', '.tsx'])) { return; }

			let previousModules: any = {};
			for (let mod in dependencyTree) {
				if (~dependencyTree[mod].indexOf(filename)) {
					previousModules[mod] = 0; // 0 is the default but signifies that the reference was removed if it remains 0
				}
			}
			const content = event.document.getText();
			const importRegex = new RegExp(`import\\s*[\\s\\S]*?\\s*from\\s*['"](.*?)['"]`, 'g');
			const requireRegex = new RegExp(`require\\s*\\(\\s*['"](.*?)['"]\\s*\\)`, 'g');

			// check for `import xxxx from 'module'` syntax
			let matches: string[] = content.match(importRegex) || [];
			for (let i = 0, len = matches.length; i < len; i++) {
				let mod: string = matches[i].replace(importRegex, '$1');
				let index = -1;
				if (mod[0] === '@') { // when dealing with namespaces, we need to account for one /
					mod = mod.replace(/(@.*?\/.*?)\/.*/, '$1');
				} else if (~(index = mod.indexOf('/'))) { // check if mod contains / and sets index to the index of the first /
					mod = mod.substring(0, index);
				}
				let flag = 10; // 10 indicates the file did not add or remove this reference
				if (previousModules[mod] === undefined) {
					flag = 1; // 1 indicates that this is new reference
				}
				previousModules[mod] = flag;
			}

			// check for `require('module')` syntax
			matches = content.match(requireRegex) || [];
			for (let i = 0, len = matches.length; i < len; i++) {
				let mod: string = matches[i].replace(requireRegex, '$1');
				let index = -1;
				if (mod[0] === '@') {
					mod = mod.replace(/(@.*?\/.*?)\/.*/, '$1');
				} else if (~(index = mod.indexOf('/'))) {
					mod = mod.substring(0, index);
				}
				let flag = 10;
				if (previousModules[mod] === undefined) {
					flag = 1;
				}
				previousModules[mod] = flag;
			}

			// update dependencyTree
			for (let name in previousModules) {
				if (previousModules[name] === 0) { // removed dependency
					dependencyTree[name].remove(filename);
					continue;
				}
				if (json.dependencies[name] && previousModules[name] === 1) { // new dependency
					dependencyTree[name] = dependencyTree[name] || [];
					dependencyTree[name].push(filename);
				}
			}


			triggerUpdateDecorations();
		}
	}

	async function init() {
		const result = await $c.stat(treeConfigPath);
		if ($c.isError(result)) {
			await $c.mkdir(`${vscode.workspace.rootPath}/.depcheck/`);
			await $c.writeFile(treeConfigPath, JSON.stringify({}));
		} else if ($c.isEmpty(dependencyTree = require(treeConfigPath))) {
			dependencyTree = undefined;

		}
		if (activeEditor) {
			triggerUpdateDecorations();
		}
		vscode.window.onDidChangeActiveTextEditor(onDidChangeActiveTextEditor, null, context.subscriptions);

		vscode.workspace.onDidChangeTextDocument(onDidChangeTextDocument, null, context.subscriptions);

	}

	async function updateDecorations(invokedFromRefresh = false) {
		filesProcessed = 0;
		if (!activeEditor) {
			return;
		}
		let decorate = true;
		// if the current file is package.json we will decorate or build dependencyTree if it has not been populated
		if ((decorate = /package\.json$/.test(activeEditor.document.fileName)) || !dependencyTree) {
			let originalText = '';
			let text = '';
			if (!decorate) {
				json = require(`${root}/package.json`);
			} else {
				originalText = activeEditor.document.getText();
				text = originalText;
			}

			json = json || JSON.parse(text);
			const dependencies = { ...json.dependencies, ...json.devDependencies };

			if (dependencies) {
				let unusedModules: string[] | undefined = undefined;
				let names: string[] = [];
				const ignoreList: any = vscode.workspace
					.getConfiguration('depcheck')
					.moduleIgnoreList
					.map((pattern: string) => new RegExp(pattern));
				if (dependencyTree) {
					unusedModules = [];
					for (let name in dependencies) {
						if (ignoreList.contains((val: RegExp) => val.test(name))) { continue; }
						if (name.startsWith('@types/')) {
							let correspondingModule = name.replace('@types/', '');
							if (dependencies[correspondingModule]) { continue; }
						}
						if (!dependencyTree[name] || !dependencyTree[name].length) { unusedModules.push(name); }
					}
				} else {
					dependencyTree = {};
					for (let name in dependencies) {
						if (ignoreList.contains((val: RegExp) => val.test(name))) { continue; }
						names.push(name);
						dependencyTree[name] = [];
					}
				}
				if (invokedFromRefresh) {
					return vscode.window.withProgress({
						location: vscode.ProgressLocation.Notification,
						title: 'Refreshing the dependency cache.',
						cancellable: false
					}, () => {
						return applyDecoration({ unusedModules, names, text, originalText, decorate });
					});
				}
				await applyDecoration({ unusedModules, names, text, originalText, decorate });
			}

		}
	}
	async function applyDecoration({ unusedModules, names, text, originalText, decorate }: any) {
		if (!activeEditor) {
			return;
		}
		let date = new Date();
		unusedModules = unusedModules || await processDir(root, [...names], [...names]);
		let time = new Date().getTime() - date.getTime();
		await $c.writeFile(treeConfigPath, JSON.stringify(dependencyTree));
		let unusedDeccorations = [];
		if (decorate) {
			for (let i = 0, len = unusedModules.length; i < len; i++) {
				text = originalText;
				let match;
				let regEx = new RegExp(`"${unusedModules[i]}"\\s*?:\\s*".*?"`);
				let removedChars = 0;
				while (match = regEx.exec(text)) {
					const startPos = activeEditor.document.positionAt(match.index + removedChars);
					const endPos = activeEditor.document.positionAt(match.index + unusedModules[i].length + 2 + removedChars);
					removedChars += unusedModules[i].length;
					text = text.substring(0, match.index + 1) + text.substring(match.index + unusedModules[i].length + 1);
					const message = filesProcessed ? `This module is not used (searched ${filesProcessed} files in ${time / 1000}s)` : `Using cached value`;
					unusedDeccorations.push({ range: new vscode.Range(startPos, endPos), hoverMessage: message });
				}
			}
			activeEditor.setDecorations(unusedDeccorationType, unusedDeccorations);
		}
	}
	function processDir(dir: string, unusedModules: string[] | any, modules: string[] | any): Promise<string[]> {
		return new Promise((res) => {
			readdir(dir, (err, items) => {
				if (err) { return res(unusedModules); }
				let completed = 0;
				for (let i = 0, len = items.length; i < len; i++) {
					filesProcessed++;
					let item: any = items[i];
					if (item.startsWith('.') || item === 'node_modules') {
						completed++;
						continue;
					}
					stat(`${dir}/${item}`, (err, stat) => {
						if (err) {
							completed++;
							if (completed === len) {
								res(unusedModules);
							}
							return;
						}
						if (stat && stat.isDirectory()) {
							return processDir(`${dir}/${item}`, unusedModules, modules).then(() => {
								completed++;
								if (completed === len) {
									res(unusedModules);
								}
							});
						}
						// if the file of file type js, jsx, ts, and tsx
						if (item.endsWithAny(['.js', '.jsx', '.ts', '.tsx'])) {
							return readFile(`${dir}/${item}`, 'utf-8', (err, content) => {
								content = removeComments(content);
								completed++;
								if (err) {
									if (completed === len) {
										res(unusedModules);
									}
									return;
								}
								let j = 0, mod;
								while (mod = modules[j++]) {
									let importRegex = new RegExp(`import\\s*.*?\\s*from\\s*['"]${mod}(/.*?)?['"]`);
									let requireRegex = new RegExp(`require\\s*\\(\\s*['"]${mod}(/.*?)?['"]\\s*\\)`);

									if ($c.contains(content, importRegex) || $c.contains(content, requireRegex)) {
										// build dependency tree
										let filepath = $c.replace_all(`${dir}/${item}`, '\\', '/').replace(root, '');
										dependencyTree[mod].push(filepath);
										unusedModules.remove(mod);
									}
								}
								if (completed === len) {
									res(unusedModules);
								}
							});
						}
						completed++;
						if (completed === len) {
							res(unusedModules);
						}
					});

				}
				if (completed === items.length) {
					res(unusedModules);
				}
			});

		});

	}

	function triggerUpdateDecorations(invokedFromRefresh = false) {
		if (timeout) {
			clearTimeout(timeout);
			timeout = undefined;
		}
		timeout = setTimeout(() => { updateDecorations(invokedFromRefresh); }, 500);
	}

	function removeComments(content: string) {
		return content.replace(/\/\/[\s\S]*?\n/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
	}

	init();
}
