import { test, expect } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
// From the bare list, not from `language.ts`: that one reaches the API client, which opens
// a socket and polls `/status` on import.
import { languages } from '../../src/scripts/languages.ts';

/**
 * Every `$t('a.b')` in the source has to exist in every language file.
 *
 * A missing key is invisible to the compiler — `$t()` takes a string — and to every test
 * that does not render the exact branch, so it reaches the user as the raw key on screen.
 * That is how renaming a message left one call site pointing at the old name.
 *
 * Literal keys only: a computed key cannot be checked here and is skipped on purpose.
 */

// `fileURLToPath`, not `.pathname`: on Windows the latter yields a leading-slash path.
const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
		else if (/\.(svelte|ts)$/.test(entry)) out.push(full);
	}
	return out;
}

function usedKeys(): Map<string, string[]> {
	const keys = new Map<string, string[]>();
	for (const file of sourceFiles(SRC)) {
		const text = readFileSync(file, 'utf8');
		for (const m of text.matchAll(/\$?\bt\(\s*'([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)'/g)) {
			const key = m[1]!;
			keys.set(key, [...(keys.get(key) ?? []), file]);
		}
	}
	return keys;
}

function lookup(table: Record<string, any>, key: string): unknown {
	let node: any = table;
	for (const part of key.split('.')) {
		if (node === null || typeof node !== 'object') return undefined;
		node = node[part];
	}
	return node;
}

for (const { id: langID } of languages) {
	test(`${langID}.json defines every key the source asks for`, async () => {
		const table = await Bun.file(new URL(`../../static/langs/${langID}.json`, import.meta.url)).json();
		const missing: string[] = [];
		for (const [key, files] of usedKeys()) {
			const value = lookup(table, key);
			// Non-empty string: an entry emptied by a bad edit renders as nothing, which the
			// screen cannot tell from a message that was never meant to show.
			if (typeof value !== 'string' || value.trim().length === 0) missing.push(`${key} (${files.map(f => f.split(/[\\/]/).pop()).join(', ')})`);
		}
		expect(missing).toEqual([]);
	});
}
