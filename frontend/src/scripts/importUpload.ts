/** State one file pick drives in the import form. */
export interface ImportUploadForm {
	setUploadID: (uploadID: string) => void;
	setFileName: (name: string) => void;
	setError: (message: string) => void;
}

/** External operations used by the upload sequencer. */
export interface ImportUploadDeps {
	upload: (file: File, onStart: (uploadID: string) => void) => Promise<string>;
	discard: (uploadID: string) => Promise<void>;
	uploadingLabel: () => string;
	formatError: (err: unknown) => string;
}

export interface ImportUploader {
	pick: (file: File) => Promise<void>;
	/** Remove the current picker selection and discard its backend upload. */
	discardSelection: () => void;
	/** Move an upload from the picker to parser-owned cleanup. */
	consume: (uploadID: string) => void;
	/** Release a parser-owned upload after parsing settles. */
	finishConsume: (uploadID: string) => void;
	unmount: () => void;
}

export interface ImportOperationController {
	start: (busyLabel: string) => number;
	invalidate: () => void;
	isActive: () => boolean;
	owns: (operation: number) => boolean;
	finish: (operation: number) => void;
	destroy: () => void;
}

/** Keep every asynchronous form operation under one monotonic owner token. */
export function createImportOperationController(setBusy: (label: string) => void): ImportOperationController {
	let current = 0;
	let active = 0;
	let mounted = true;
	return {
		start(busyLabel: string): number {
			const operation = ++current;
			active = operation;
			if (mounted) setBusy(busyLabel);
			return operation;
		},
		invalidate(): void {
			current++;
			active = 0;
			if (mounted) setBusy('');
		},
		isActive(): boolean {
			return mounted && active !== 0 && active === current;
		},
		owns(operation: number): boolean {
			return mounted && operation === current;
		},
		finish(operation: number): void {
			if (mounted && operation === current) {
				active = 0;
				setBusy('');
			}
		},
		destroy(): void {
			mounted = false;
			current++;
			active = 0;
		},
	};
}

/**
 * Sequence file picks so only the newest one can update the form. Upload ids are
 * recorded before `upload.begin` is sent, allowing a later pick or unmount to
 * abort a transfer that has not reached `upload.end` yet.
 */
export function createImportUploader(form: ImportUploadForm, deps: ImportUploadDeps, operations: ImportOperationController): ImportUploader {
	let mounted = true;
	let activeUploadID = '';
	const consumedUploadIDs = new Set<string>();
	const cleanups = new Map<string, { promise: Promise<void>; retryOnFailure: boolean }>();

	function discard(uploadID: string, retryOnFailure = false): Promise<void> {
		const existing = cleanups.get(uploadID);
		if (existing) {
			if (retryOnFailure) existing.retryOnFailure = true;
			return existing.promise;
		}
		const cleanup = { promise: Promise.resolve(), retryOnFailure };
		const promise = Promise.resolve().then(() => deps.discard(uploadID));
		cleanup.promise = promise;
		cleanups.set(uploadID, cleanup);
		void promise.then(
			() => {
				if (cleanups.get(uploadID) !== cleanup) return;
				cleanups.delete(uploadID);
				if (activeUploadID === uploadID) activeUploadID = '';
				consumedUploadIDs.delete(uploadID);
			},
			() => {
				if (cleanups.get(uploadID) !== cleanup) return;
				cleanups.delete(uploadID);
				if (cleanup.retryOnFailure) void discard(uploadID).catch(() => {});
			}
		);
		return promise;
	}

	return {
		async pick(file: File): Promise<void> {
			const operation = operations.start(deps.uploadingLabel());
			const owns = (): boolean => mounted && operations.owns(operation);
			const previous = activeUploadID;
			form.setUploadID('');
			form.setFileName(file.name);
			form.setError('');
			try {
				// Cleanup is a barrier: the new transfer must not claim quota beside a
				// file the same form has already abandoned.
				if (previous) await discard(previous);
				if (!owns()) return;
				const uploadID = await deps.upload(file, started => {
					if (owns()) activeUploadID = started;
					else void discard(started).catch(() => {});
				});
				if (owns()) {
					activeUploadID = uploadID;
					form.setUploadID(uploadID);
				} else {
					void discard(uploadID).catch(() => {});
				}
			} catch (err) {
				if (!owns()) return;
				form.setError(deps.formatError(err));
				form.setFileName('');
			} finally {
				operations.finish(operation);
			}
		},
		discardSelection(): void {
			form.setUploadID('');
			form.setFileName('');
			if (activeUploadID) void discard(activeUploadID).catch(() => {});
		},
		consume(uploadID: string): void {
			if (activeUploadID === uploadID) activeUploadID = '';
			form.setUploadID('');
			form.setFileName('');
			if (mounted) consumedUploadIDs.add(uploadID);
			else void discard(uploadID).catch(() => {});
		},
		finishConsume(uploadID: string): void {
			if (consumedUploadIDs.has(uploadID)) void discard(uploadID).catch(() => {});
		},
		unmount(): void {
			mounted = false;
			operations.destroy();
			const uploadID = activeUploadID;
			if (uploadID) void discard(uploadID, true).catch(() => {});
			for (const consumedUploadID of consumedUploadIDs) void discard(consumedUploadID, true).catch(() => {});
		},
	};
}
