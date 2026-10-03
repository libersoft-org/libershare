import { expect, test } from 'bun:test';
import ts from 'typescript';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../src');
const allowed = new Map([
	['network-helper-client.ts:runTrackedHelper', 'spawn'],
	['native/linux/time-access-probe.ts:probeNativeTimeServiceAccess', 'Bun.spawn'],
	['native/darwin/time-clock-probe.ts:runDarwinClockProbeChild', 'Bun.spawn'],
]);

function owner(node: ts.Node): string {
	for (let parent = node.parent; parent; parent = parent.parent) if (ts.isFunctionDeclaration(parent) && parent.name) return parent.name.text;
	return '<module>';
}

function processCalls(source: string, file: string): string[] {
	const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
	const violations: string[] = [];
	const imported = new Set<string>();
	const report = (node: ts.Node, reason: string): void => {
		violations.push(`${file}:${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1}: ${reason}`);
	};
	const visit = (node: ts.Node): void => {
		if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && /^(?:node:)?child_process$/.test(node.moduleSpecifier.text)) {
			const bindings = node.importClause?.namedBindings;
			if (file !== 'network-helper-client.ts' || node.importClause?.name || !bindings || !ts.isNamedImports(bindings)) report(node, 'Child-process imports are not allowed here');
			else
				for (const item of bindings.elements) {
					if ((item.propertyName ?? item.name).text !== 'spawn') report(item, 'Only the tracked helper launcher may import spawn');
					imported.add(item.name.text);
				}
		}
		if (ts.isCallExpression(node)) {
			const expression = node.expression;
			if ((expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(expression) && expression.text === 'require')) && node.arguments.some(arg => ts.isStringLiteral(arg) && /^(?:node:)?child_process$/.test(arg.text))) report(node, 'Dynamic child-process imports are not allowed');
			const call = ts.isIdentifier(expression) && imported.has(expression.text) ? 'spawn' : ts.isPropertyAccessExpression(expression) && expression.expression.getText(ast) === 'Bun' && ['spawn', 'spawnSync'].includes(expression.name.text) ? `Bun.${expression.name.text}` : undefined;
			if (call && allowed.get(`${file}:${owner(node)}`) !== call) report(node, `Unexpected process launch ${call}`);
		}
		if (ts.isIdentifier(node) && imported.has(node.text) && !ts.isImportSpecifier(node.parent) && !(ts.isCallExpression(node.parent) && node.parent.expression === node)) report(node, 'A process launcher cannot be aliased or passed to another function');
		ts.forEachChild(node, visit);
	};
	visit(ast);
	return violations;
}

test('backend child processes are limited to tracked elevation and isolated probes', () => {
	const violations = readdirSync(root, { recursive: true, withFileTypes: true })
		.filter(entry => entry.isFile() && /\.(?:ts|js)$/.test(entry.name))
		.flatMap(entry => {
			const path = join(entry.parentPath, entry.name);
			return processCalls(readFileSync(path, 'utf8'), relative(root, path).replaceAll('\\', '/'));
		});
	expect(violations).toEqual([]);
});

test('the process guard rejects an alias and a launch outside the allowed function', () => {
	expect(processCalls("import { spawn as launch } from 'node:child_process'; function other() { launch('example'); }", 'network-helper-client.ts')).toHaveLength(1);
	expect(processCalls("import { spawn } from 'node:child_process'; const launch = spawn;", 'network-helper-client.ts')).toHaveLength(1);
	expect(processCalls("Bun.spawnSync(['example']);", 'native/example.ts')).toHaveLength(1);
});
