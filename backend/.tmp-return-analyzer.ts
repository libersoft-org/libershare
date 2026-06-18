// Temporary analyzer: finds functions whose effective return type is an
// anonymous object type (not a named interface/type alias/class) with >= 2 properties.
// Unwraps Promise<T>. Reports file/line/name + property shapes.
// Usage: bun .tmp-return-analyzer.ts <tsconfig-path> [rootDirFilter]
import ts from 'typescript';
import * as path from 'path';

const tsconfigPath: string = path.resolve(process.argv[2]!);
const rootFilter: string | null = process.argv[3] ? path.resolve(process.argv[3]) : null;

const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
if (configFile.error) {
	console.error('config error', configFile.error.messageText);
	process.exit(1);
}
const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(tsconfigPath));
const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
const checker = program.getTypeChecker();

interface Candidate {
	file: string;
	line: number;
	name: string;
	exported: boolean;
	hasAnnotation: boolean;
	annotationKind: string;
	props: string[];
}
const candidates: Candidate[] = [];

function unwrapPromise(type: ts.Type): ts.Type {
	const sym = type.getSymbol();
	if (sym && sym.getName() === 'Promise') {
		const ref = type as ts.TypeReference;
		const args = checker.getTypeArguments(ref);
		if (args.length === 1) return args[0]!;
	}
	return type;
}

function arrayElement(typeIn: ts.Type): ts.Type | null {
	const type = unwrapPromise(typeIn);
	const sym = type.getSymbol();
	if (sym && (sym.getName() === 'Array' || sym.getName() === 'ReadonlyArray')) {
		const args = checker.getTypeArguments(type as ts.TypeReference);
		if (args.length === 1) return args[0]!;
	}
	return null;
}

function isAnonymousObjectWith2Props(typeIn: ts.Type): string[] | null {
	const type = unwrapPromise(typeIn);
	// named type alias -> skip
	if (type.aliasSymbol) return null;
	// must be an object type, not union/intersection/primitive
	if (!(type.flags & ts.TypeFlags.Object)) return null;
	const objFlags = (type as ts.ObjectType).objectFlags;
	// exclude tuples
	if (objFlags & ts.ObjectFlags.Tuple) return null;
	const sym = type.getSymbol();
	if (sym) {
		// named interface / class / enum -> skip
		if (sym.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.Class | ts.SymbolFlags.Enum)) return null;
		const name = sym.getName();
		// anonymous object literals have synthetic name "__type"; objects from `{...}` get "__object"
		if (name && name !== '__type' && name !== '__object') return null;
	}
	// exclude arrays/tuples/mapped/instantiated-from-named via reference to named target
	if (objFlags & ts.ObjectFlags.Reference) {
		const target = (type as ts.TypeReference).target;
		if ((target as ts.ObjectType).objectFlags & ts.ObjectFlags.Tuple) return null;
		const tsym = target.getSymbol();
		if (tsym && tsym.getName() !== '__type' && tsym.getName() !== '__object') return null;
	}
	const props = checker.getPropertiesOfType(type);
	if (props.length < 2) return null;
	// exclude if any "property" is actually a call/construct signature only object (function type)
	if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) return null;
	return props.map((p: ts.Symbol): string => {
		const pt = checker.getTypeOfSymbol(p);
		const optional = p.flags & ts.SymbolFlags.Optional ? '?' : '';
		return `${p.getName()}${optional}: ${checker.typeToString(pt)}`;
	});
}

function getName(node: ts.Node): string {
	if (ts.isFunctionDeclaration(node) && node.name) return node.name.getText();
	if (ts.isMethodDeclaration(node) && node.name) return node.name.getText();
	if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
		const parent = node.parent;
		if (ts.isVariableDeclaration(parent) && parent.name) return parent.name.getText();
		if (ts.isPropertyDeclaration(parent) && parent.name) return parent.name.getText();
		// object-literal property arrows are inline mocks/data, not declared functions -> skip
	}
	return '<anonymous>';
}

function isExported(node: ts.Node): boolean {
	const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
	if (mods && mods.some((m: ts.Modifier): boolean => m.kind === ts.SyntaxKind.ExportKeyword)) return true;
	// variable statement export
	let p: ts.Node | undefined = node.parent;
	while (p) {
		if (ts.isVariableStatement(p)) {
			const vmods = ts.getModifiers(p);
			return !!(vmods && vmods.some((m: ts.Modifier): boolean => m.kind === ts.SyntaxKind.ExportKeyword));
		}
		if (ts.isSourceFile(p)) break;
		p = p.parent;
	}
	return false;
}

function annotationKind(node: ts.FunctionLikeDeclaration): { has: boolean; kind: string } {
	const t = node.type;
	if (!t) return { has: false, kind: 'inferred' };
	if (ts.isTypeLiteralNode(t)) return { has: true, kind: 'inline-object' };
	if (ts.isTypeReferenceNode(t) && t.typeName.getText() === 'Promise' && t.typeArguments && t.typeArguments[0] && ts.isTypeLiteralNode(t.typeArguments[0]!)) return { has: true, kind: 'inline-promise-object' };
	return { has: true, kind: t.getText().slice(0, 40) };
}

for (const sf of program.getSourceFiles()) {
	if (sf.isDeclarationFile) continue;
	if (sf.fileName.includes('node_modules')) continue;
	if (rootFilter && !sf.fileName.startsWith(rootFilter)) continue;
	const visit = (node: ts.Node): void => {
		if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)) {
			const name = getName(node);
			// skip unnamed inline callbacks (map/filter/etc.) - their object shapes
			// are covered by the enclosing named function returning an array.
			if (name !== '<anonymous>') {
				const sig = checker.getSignatureFromDeclaration(node);
				if (sig) {
					const ret = checker.getReturnTypeOfSignature(sig);
					let kind = 'object';
					let props = isAnonymousObjectWith2Props(ret);
					if (!props) {
						const el = arrayElement(ret);
						if (el) {
							props = isAnonymousObjectWith2Props(el);
							kind = 'object[]';
						}
					}
					if (props) {
						const ak = annotationKind(node);
						const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
						candidates.push({
							file: path.relative(process.cwd(), sf.fileName),
							line: line + 1,
							name: `${name} (${kind})`,
							exported: isExported(node),
							hasAnnotation: ak.has,
							annotationKind: ak.kind,
							props,
						});
					}
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
}

candidates.sort((a: Candidate, b: Candidate): number => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));
for (const c of candidates) {
	console.log(`${c.file}:${c.line}  ${c.name}  [exported=${c.exported}, ann=${c.annotationKind}]`);
	console.log(`    { ${c.props.join('; ')} }`);
}
console.log(`\nTOTAL: ${candidates.length}`);
