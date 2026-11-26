import { afterAll, describe, expect, it } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const app = resolve(import.meta.dir, '../../../app');
const scratch: string[] = [];
afterAll(() => {
	for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** Run the real generator on a copy of its templates, with the given product name. */
function generate(name: string): string {
	const root = mkdtempSync(join(tmpdir(), 'lish-sync-config-'));
	scratch.push(root);
	mkdirSync(join(root, 'app'));
	mkdirSync(join(root, 'shared', 'src'), { recursive: true });
	for (const file of ['sync-config.ts', 'tauri.conf.json.template', 'tauri.linux.conf.json.template', 'Info.plist.template']) copyFileSync(join(app, file), join(root, 'app', file));
	writeFileSync(join(root, 'shared', 'src', 'product.json'), JSON.stringify({ name, version: '1.2.3', identifier: 'org.example.product' }));
	const run = Bun.spawnSync([process.execPath, join(root, 'app', 'sync-config.ts')]);
	expect(run.exitCode).toBe(0);
	return join(root, 'app');
}

describe('generated app configuration', () => {
	it('puts the product name into the macOS location prompt', () => {
		const out = generate('Example');
		expect(readFileSync(join(out, 'Info.plist'), 'utf8')).toContain('<string>Example needs your location');
		expect(JSON.parse(readFileSync(join(out, 'tauri.conf.json'), 'utf8')).productName).toBe('Example');
	});

	it('keeps the plist well formed for a product name with XML characters', () => {
		const out = generate('Research & <Share>');
		expect(readFileSync(join(out, 'Info.plist'), 'utf8')).toContain('<string>Research &amp; &lt;Share&gt; needs your location');
		// The JSON configs take the name as it is.
		expect(JSON.parse(readFileSync(join(out, 'tauri.conf.json'), 'utf8')).productName).toBe('Research & <Share>');
	});
});
