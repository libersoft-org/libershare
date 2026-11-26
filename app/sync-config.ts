#!/usr/bin/env bun
// Generates app/tauri.conf.json, app/tauri.linux.conf.json and app/Info.plist
// from their committed *.template counterparts, substituting product metadata
// from shared/src/product.json (the single source of truth for branding).
//
// The generated files are gitignored. This script is invoked
// automatically by build.sh / build.bat before bundling and by build.rs
// before the Rust crate is compiled, so the configs always exist and stay
// in sync with product.json without any manual step.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const appDir = import.meta.dir;
const productJsonPath = join(appDir, '..', 'shared', 'src', 'product.json');

interface IProduct {
	name: string;
	version: string;
	identifier: string;
}

const product = JSON.parse(readFileSync(productJsonPath, 'utf8')) as IProduct;

const replacements: Record<string, string> = {
	'{{PRODUCT_NAME}}': product.name,
	'{{PRODUCT_NAME_LOWER}}': product.name.toLowerCase(),
	'{{PRODUCT_VERSION}}': product.version,
	'{{PRODUCT_IDENTIFIER}}': product.identifier,
};

const targets: Array<[template: string, output: string]> = [
	['tauri.conf.json.template', 'tauri.conf.json'],
	['tauri.linux.conf.json.template', 'tauri.linux.conf.json'],
	['Info.plist.template', 'Info.plist'],
];

/** A value as the text of an XML element: a product name may hold `&`, which would break the plist. */
function xmlText(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function render(text: string, escape: (value: string) => string): string {
	let out = text;
	for (const [token, value] of Object.entries(replacements)) out = out.split(token).join(escape(value));
	return out;
}

let updated = 0;
for (const [templateName, outputName] of targets) {
	const templatePath = join(appDir, templateName);
	const outputPath = join(appDir, outputName);
	const rendered = render(readFileSync(templatePath, 'utf8'), outputName.endsWith('.plist') ? xmlText : value => value);
	const current = existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : null;
	if (current === rendered) continue;
	writeFileSync(outputPath, rendered);
	console.log(`[sync-config] wrote ${outputName}`);
	updated++;
}

console.log(`[sync-config] ${product.name} v${product.version} (${product.identifier}) - ${updated} file(s) updated`);
