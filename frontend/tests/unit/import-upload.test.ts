/**
 * Unit tests for the import form's file-pick sequencer in
 * `src/scripts/importUpload.ts`.
 *
 * The picker stays reachable during an upload (the busy dialog blocks the mouse
 * but registers no navigation area), so two picks can overlap. The slower one
 * must never win: it may not point the form at a file the user is no longer
 * looking at, may not strand its own copy on the backend's disk, and may not
 * clear the busy label while the newer transfer is still running.
 */
import { test, expect } from 'bun:test';
import { createImportUploader, importCleanup, type ImportUploadForm, type ImportUploadDeps } from '../../src/scripts/importUpload.ts';

/** A file pick the test resolves or rejects by hand, so two picks can be interleaved. */
interface PendingUpload {
	path: string;
	resolve: () => void;
	reject: (err: unknown) => void;
}

function harness() {
	const state = { path: '', fileName: '', error: '', busy: '' };
	const discarded: string[] = [];
	const pending: PendingUpload[] = [];
	const form: ImportUploadForm = {
		getPath: () => state.path,
		setPath: path => (state.path = path),
		setFileName: name => (state.fileName = name),
		setError: message => (state.error = message),
		setBusy: label => (state.busy = label),
	};
	const deps: ImportUploadDeps = {
		upload: file =>
			new Promise<string>((resolve, reject) => {
				const path = `/tmp/${file.name}`;
				pending.push({ path, resolve: () => resolve(path), reject });
			}),
		discard: path => discarded.push(path),
		uploadingLabel: () => 'uploading',
		formatError: err => `error:${String(err)}`,
	};
	return { state, discarded, pending, uploader: createImportUploader(form, deps) };
}

function pickedFile(name: string): File {
	return new File(['x'], name);
}

test('a superseded pick discards its own upload instead of overwriting the newer one', async () => {
	const h = harness();
	const first = h.uploader.pick(pickedFile('first.lish'));
	const second = h.uploader.pick(pickedFile('second.lish'));
	// The newer transfer finishes first; the abandoned one lands afterwards.
	h.pending[1]!.resolve();
	await second;
	h.pending[0]!.resolve();
	await first;
	expect(h.state.path).toBe('/tmp/second.lish');
	expect(h.state.fileName).toBe('second.lish');
	expect(h.discarded).toEqual(['/tmp/first.lish']);
});

test('the busy label survives a superseded pick finishing first', async () => {
	const h = harness();
	const first = h.uploader.pick(pickedFile('first.lish'));
	const second = h.uploader.pick(pickedFile('second.lish'));
	h.pending[0]!.resolve();
	await first;
	// The second upload is still running — the spinner must still be up.
	expect(h.state.busy).toBe('uploading');
	h.pending[1]!.resolve();
	await second;
	expect(h.state.busy).toBe('');
});

test('a superseded pick reports no error over the newer one', async () => {
	const h = harness();
	const first = h.uploader.pick(pickedFile('first.lish'));
	const second = h.uploader.pick(pickedFile('second.lish'));
	h.pending[0]!.reject(new Error('boom'));
	await first;
	expect(h.state.error).toBe('');
	expect(h.state.fileName).toBe('second.lish');
	h.pending[1]!.resolve();
	await second;
	expect(h.state.path).toBe('/tmp/second.lish');
});

test('picking again drops the file the form already holds', async () => {
	const h = harness();
	const first = h.uploader.pick(pickedFile('first.lish'));
	h.pending[0]!.resolve();
	await first;
	expect(h.state.path).toBe('/tmp/first.lish');
	const second = h.uploader.pick(pickedFile('second.lish'));
	expect(h.discarded).toEqual(['/tmp/first.lish']);
	h.pending[1]!.resolve();
	await second;
	expect(h.state.path).toBe('/tmp/second.lish');
});

test('an upload that lands after the form is gone discards itself', async () => {
	const h = harness();
	const first = h.uploader.pick(pickedFile('first.lish'));
	h.uploader.unmount();
	h.pending[0]!.resolve();
	await first;
	expect(h.state.path).toBe('');
	expect(h.discarded).toEqual(['/tmp/first.lish']);
});

test('a lone failing upload still reports its error and clears the spinner', async () => {
	const h = harness();
	const only = h.uploader.pick(pickedFile('first.lish'));
	h.pending[0]!.reject('boom');
	await only;
	expect(h.state.error).toBe('error:boom');
	expect(h.state.fileName).toBe('');
	expect(h.state.busy).toBe('');
});

test('an import deletes the copy it parsed, not whatever the form holds now', () => {
	// The user picked a second file while the first one was being parsed. The import
	// must clean up its own copy and leave the newer pick showing in the form.
	const cleanup = importCleanup('/tmp/parsed.lish', '/tmp/newer.lish');
	expect(cleanup.discard).toBe('/tmp/parsed.lish');
	expect(cleanup.clearForm).toBe(false);
});

test('an import clears the form when it still shows the file it parsed', () => {
	const cleanup = importCleanup('/tmp/parsed.lish', '/tmp/parsed.lish');
	expect(cleanup.discard).toBe('/tmp/parsed.lish');
	expect(cleanup.clearForm).toBe(true);
});
