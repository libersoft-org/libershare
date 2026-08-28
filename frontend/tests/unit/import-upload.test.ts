import { test, expect } from 'bun:test';
import { createImportUploader, importOwnsForm, type ImportUploadForm, type ImportUploadDeps } from '../../src/scripts/importUpload.ts';

interface PendingUpload {
	id: string;
	resolve: () => void;
	reject: (err: unknown) => void;
}

function harness() {
	const state = { uploadID: '', fileName: '', error: '', busy: '' };
	const discarded: string[] = [];
	const pending: PendingUpload[] = [];
	let discardError: unknown;
	const form: ImportUploadForm = {
		getUploadID: () => state.uploadID,
		setUploadID: uploadID => (state.uploadID = uploadID),
		setFileName: name => (state.fileName = name),
		setError: message => (state.error = message),
		setBusy: label => (state.busy = label),
	};
	const deps: ImportUploadDeps = {
		upload: (file, onStart) => {
			const id = `upload-${file.name}`;
			onStart(id);
			return new Promise<string>((resolve, reject) => pending.push({ id, resolve: () => resolve(id), reject }));
		},
		discard: async uploadID => {
			discarded.push(uploadID);
			if (discardError !== undefined) throw discardError;
		},
		uploadingLabel: () => 'uploading',
		formatError: err => `error:${String(err)}`,
	};
	return {
		state,
		discarded,
		pending,
		failDiscard: (err: unknown) => (discardError = err),
		uploader: createImportUploader(form, deps),
	};
}

function pickedFile(name: string): File {
	return new File(['x'], name);
}

async function advance(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

async function waitUntil(predicate: () => boolean): Promise<void> {
	for (let i = 0; i < 20 && !predicate(); i++) await Promise.resolve();
	expect(predicate()).toBe(true);
}

test('a newer pick aborts the in-flight upload and is the only one that wins', async () => {
	const h = harness();
	const first = h.uploader.pick(pickedFile('first.lish'));
	const second = h.uploader.pick(pickedFile('second.lish'));
	await waitUntil(() => h.pending.length === 2);
	expect(h.discarded).toEqual(['upload-first.lish']);
	expect(h.pending).toHaveLength(2);
	h.pending[1]!.resolve();
	await second;
	h.pending[0]!.reject(new Error('aborted'));
	await first;
	expect(h.state.uploadID).toBe('upload-second.lish');
	expect(h.state.fileName).toBe('second.lish');
});

test('a superseded upload cannot clear the newer busy label or report an error', async () => {
	const h = harness();
	const first = h.uploader.pick(pickedFile('first.lish'));
	const second = h.uploader.pick(pickedFile('second.lish'));
	await waitUntil(() => h.pending.length === 2);
	h.pending[0]!.reject(new Error('aborted'));
	await first;
	expect(h.state.busy).toBe('uploading');
	expect(h.state.error).toBe('');
	h.pending[1]!.resolve();
	await second;
	expect(h.state.busy).toBe('');
});

test('picking again aborts a completed upload before starting the replacement', async () => {
	const h = harness();
	const first = h.uploader.pick(pickedFile('first.lish'));
	h.pending[0]!.resolve();
	await first;
	const second = h.uploader.pick(pickedFile('second.lish'));
	await waitUntil(() => h.pending.length === 2);
	expect(h.discarded).toEqual(['upload-first.lish']);
	h.pending[1]!.resolve();
	await second;
	expect(h.state.uploadID).toBe('upload-second.lish');
});

test('cleanup failure stops the replacement upload and is shown to the user', async () => {
	const h = harness();
	const first = h.uploader.pick(pickedFile('first.lish'));
	h.pending[0]!.resolve();
	await first;
	h.failDiscard(new Error('cleanup failed'));
	await h.uploader.pick(pickedFile('second.lish'));
	expect(h.pending).toHaveLength(1);
	expect(h.state.uploadID).toBe('');
	expect(h.state.fileName).toBe('');
	expect(h.state.error).toContain('cleanup failed');
});

test('a failed transfer keeps its started id so the next pick retries cleanup', async () => {
	const h = harness();
	const first = h.uploader.pick(pickedFile('first.lish'));
	h.pending[0]!.reject(new Error('connection lost'));
	await first;
	expect(h.state.error).toContain('connection lost');
	const second = h.uploader.pick(pickedFile('second.lish'));
	await waitUntil(() => h.pending.length === 2);
	expect(h.discarded).toEqual(['upload-first.lish']);
	h.pending[1]!.resolve();
	await second;
	expect(h.state.uploadID).toBe('upload-second.lish');
});

test('rapid replacement picks share one cleanup barrier before the newest upload starts', async () => {
	const state = { uploadID: '', fileName: '', error: '', busy: '' };
	const pending: PendingUpload[] = [];
	let releaseCleanup: (() => void) | undefined;
	let discardCalls = 0;
	const uploader = createImportUploader(
		{
			getUploadID: () => state.uploadID,
			setUploadID: value => (state.uploadID = value),
			setFileName: value => (state.fileName = value),
			setError: value => (state.error = value),
			setBusy: value => (state.busy = value),
		},
		{
			upload: (file, onStart) => {
				const id = `upload-${file.name}`;
				onStart(id);
				return new Promise<string>((resolve, reject) => pending.push({ id, resolve: () => resolve(id), reject }));
			},
			discard: async () => {
				discardCalls++;
				await new Promise<void>(resolve => (releaseCleanup = resolve));
			},
			uploadingLabel: () => 'uploading',
			formatError: String,
		}
	);
	const first = uploader.pick(pickedFile('first.lish'));
	const second = uploader.pick(pickedFile('second.lish'));
	const third = uploader.pick(pickedFile('third.lish'));
	await advance();
	expect(discardCalls).toBe(1);
	expect(pending).toHaveLength(1);
	releaseCleanup!();
	await waitUntil(() => pending.length === 2);
	expect(pending).toHaveLength(2);
	pending[1]!.resolve();
	await third;
	await second;
	pending[0]!.reject(new Error('aborted'));
	await first;
	expect(state.uploadID).toBe('upload-third.lish');
});

test('unmount aborts an upload that has started but not finished', async () => {
	const h = harness();
	const upload = h.uploader.pick(pickedFile('first.lish'));
	h.uploader.unmount();
	await advance();
	expect(h.discarded).toEqual(['upload-first.lish']);
	h.pending[0]!.reject(new Error('aborted'));
	await upload;
	expect(h.state.uploadID).toBe('');
});

test('an upload that starts after unmount is immediately discarded', async () => {
	let start: ((id: string) => void) | undefined;
	let finish: ((id: string) => void) | undefined;
	const discarded: string[] = [];
	const state = { uploadID: '', fileName: '', error: '', busy: '' };
	const uploader = createImportUploader(
		{
			getUploadID: () => state.uploadID,
			setUploadID: value => (state.uploadID = value),
			setFileName: value => (state.fileName = value),
			setError: value => (state.error = value),
			setBusy: value => (state.busy = value),
		},
		{
			upload: (_file, onStart) =>
				new Promise(resolve => {
					start = onStart;
					finish = resolve;
				}),
			discard: async id => void discarded.push(id),
			uploadingLabel: () => 'uploading',
			formatError: String,
		}
	);
	const pick = uploader.pick(pickedFile('late.lish'));
	uploader.unmount();
	start!('late-id');
	finish!('late-id');
	await pick;
	await advance();
	expect(discarded).toContain('late-id');
	expect(state.uploadID).toBe('');
});

test('consuming an upload prevents a newer pick from aborting the active parse', async () => {
	const h = harness();
	const first = h.uploader.pick(pickedFile('first.lish'));
	h.pending[0]!.resolve();
	await first;
	h.uploader.consume('upload-first.lish');
	const second = h.uploader.pick(pickedFile('second.lish'));
	await advance();
	expect(h.discarded).toEqual([]);
	h.pending[1]!.resolve();
	await second;
});

test('unmount aborts an upload while its parse is still pending', async () => {
	const h = harness();
	const first = h.uploader.pick(pickedFile('first.lish'));
	h.pending[0]!.resolve();
	await first;
	h.uploader.consume('upload-first.lish');
	h.uploader.unmount();
	await advance();
	expect(h.discarded).toEqual(['upload-first.lish']);
});

test('unmount aborts every upload owned by concurrent parses', async () => {
	const h = harness();
	const first = h.uploader.pick(pickedFile('first.lish'));
	h.pending[0]!.resolve();
	await first;
	h.uploader.consume('upload-first.lish');
	const second = h.uploader.pick(pickedFile('second.lish'));
	h.pending[1]!.resolve();
	await second;
	h.uploader.consume('upload-second.lish');
	h.uploader.unmount();
	await advance();
	expect(h.discarded).toEqual(['upload-first.lish', 'upload-second.lish']);
});

test('finishing a parse aborts transport leftovers only once', async () => {
	const h = harness();
	const first = h.uploader.pick(pickedFile('first.lish'));
	h.pending[0]!.resolve();
	await first;
	h.uploader.consume('upload-first.lish');
	h.uploader.finishConsume('upload-first.lish');
	h.uploader.unmount();
	await advance();
	expect(h.discarded).toEqual(['upload-first.lish']);
});

test('a parse loses the form after either a mode change or a newer selection', () => {
	expect(importOwnsForm(true, true, 'newer', 'parsed')).toBe(false);
	expect(importOwnsForm(true, false, '/data/file.lish', 'parsed')).toBe(false);
	expect(importOwnsForm(false, true, 'upload-id', '/data/file.lish')).toBe(false);
});

test('a parse still owns the unchanged selection in the same mode', () => {
	expect(importOwnsForm(true, true, 'upload-id', 'upload-id')).toBe(true);
	expect(importOwnsForm(false, false, '/data/file.lish', '/data/file.lish')).toBe(true);
});

test('a completed parse cannot own a destroyed form', () => {
	expect(importOwnsForm(true, true, 'upload-id', 'upload-id', false)).toBe(false);
});
