// On-demand V8 heap snapshot trigger.
//
// Triggers:
//   - File watcher: `touch <dataDir>/trigger-heap` → writes heap snapshot,
//     then deletes the trigger file. Cross-platform (works on Windows too).
//   - POSIX signal: SIGUSR2 → same effect. No-op on Windows (signal unsupported).
//
// Output: <dataDir>/heap-<timestamp>.heapsnapshot
//
// Open in Chrome DevTools → Memory → Load profile. Diff two snapshots to see
// which constructor retained more bytes between them.

import v8 from 'node:v8';
import { watch } from 'node:fs';
import { unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';

let started = false;
let dataDir: string | null = null;

async function writeSnapshot(reason: string): Promise<string | null> {
	if (!dataDir) return null;
	const ts = new Date().toISOString().replace(/[:.]/g, '-');
	const path = join(dataDir, `heap-${ts}.heapsnapshot`);
	try {
		const started = Date.now();
		const written = v8.writeHeapSnapshot(path);
		const ms = Date.now() - started;
		const st = await stat(written).catch(() => null);
		const sizeMb = st ? (st.size / 1048576).toFixed(1) : '?';
		console.log(`[HEAP] snapshot written (${reason}): ${written} — ${sizeMb} MB in ${ms}ms`);
		return written;
	} catch (err) {
		console.error('[HEAP] snapshot failed:', err);
		return null;
	}
}

async function handleTrigger(filename: string): Promise<void> {
	if (!dataDir) return;
	if (filename !== 'trigger-heap') return;
	const triggerPath = join(dataDir, 'trigger-heap');
	try {
		await stat(triggerPath);
	} catch {
		return; // file already removed
	}
	await writeSnapshot('file-trigger');
	try { await unlink(triggerPath); } catch { /* ignore */ }
}

export function startHeapSnapshotTrigger(dir: string): void {
	if (started) return;
	started = true;
	dataDir = dir;

	// File watcher — cross-platform. Watches dataDir for `trigger-heap` file.
	try {
		watch(dir, (_event, filename) => {
			if (!filename) return;
			handleTrigger(filename.toString()).catch(() => { /* ignore */ });
		});
		console.log(`[HEAP] file-watch trigger ready: touch ${join(dir, 'trigger-heap')} to dump heap`);
	} catch (err) {
		console.warn('[HEAP] fs.watch unavailable:', err);
	}

	// POSIX signal — no-op on Windows.
	if (process.platform !== 'win32') {
		try {
			process.on('SIGUSR2', () => {
				writeSnapshot('SIGUSR2').catch(() => { /* ignore */ });
			});
			console.log(`[HEAP] SIGUSR2 handler ready: kill -USR2 ${process.pid} to dump heap`);
		} catch { /* ignore */ }
	}
}
