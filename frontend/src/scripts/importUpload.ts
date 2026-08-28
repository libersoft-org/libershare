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
	/** Move an upload from the picker to parser-owned cleanup. */
	consume: (uploadID: string) => void;
	/** Release a parser-owned upload after parsing settles. */
	finishConsume: (uploadID: string) => void;
	unmount: () => void;
}

export interface ImportOperationController {
	start: (busyLabel: string) => number;
	invalidate: () => void;
	owns: (operation: number) => boolean;
	finish: (operation: number) => void;
	destroy: () => void;
}

/** Keep every asynchronous form operation under one monotonic owner token. */
export function createImportOperationController(setBusy: (label: string) => void): ImportOperationController {
	let current = 0;
	let mounted = true;
	return {
		start(busyLabel: string): number {
			const operation = ++current;
			if (mounted) setBusy(busyLabel);
			return operation;
		},
		invalidate(): void {
			current++;
			if (mounted) setBusy('');
		},
		owns(operation: number): boolean {
			return mounted && operation === current;
		},
		finish(operation: number): void {
			if (mounted && operation === current) setBusy('');
		},
		destroy(): void {
			mounted = false;
			current++;
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
	const consumedCleanups = new Map<string, Promise<void>>();
	const retryConsumedAfterFailure = new Set<string>();
	let cleanup: { uploadID: string; promise: Promise<void> } | null = null;

	function discardQuietly(uploadID: string): void {
		void deps.discard(uploadID).catch(() => {});
	}

	function discardConsumed(uploadID: string, retryOnFailure = false): void {
		if (!consumedUploadIDs.has(uploadID)) return;
		if (retryOnFailure) retryConsumedAfterFailure.add(uploadID);
		if (consumedCleanups.has(uploadID)) return;
		const promise = Promise.resolve().then(() => deps.discard(uploadID));
		consumedCleanups.set(uploadID, promise);
		void promise.then(
			() => {
				if (consumedCleanups.get(uploadID) !== promise) return;
				consumedCleanups.delete(uploadID);
				consumedUploadIDs.delete(uploadID);
				retryConsumedAfterFailure.delete(uploadID);
			},
			() => {
				if (consumedCleanups.get(uploadID) !== promise) return;
				consumedCleanups.delete(uploadID);
				if (!retryConsumedAfterFailure.delete(uploadID)) return;
				discardConsumed(uploadID);
			}
		);
	}

	function discardActive(uploadID: string): Promise<void> {
		if (cleanup?.uploadID === uploadID) return cleanup.promise;
		const promise = Promise.resolve().then(() => deps.discard(uploadID));
		cleanup = { uploadID, promise };
		void promise.then(
			() => {
				if (activeUploadID === uploadID) activeUploadID = '';
				if (cleanup?.promise === promise) cleanup = null;
			},
			() => {
				// Keep the id active so a later pick can retry cleanup.
				if (cleanup?.promise === promise) cleanup = null;
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
				if (previous) await discardActive(previous);
				if (!owns()) return;
				const uploadID = await deps.upload(file, started => {
					if (owns()) activeUploadID = started;
					else discardQuietly(started);
				});
				if (owns()) {
					activeUploadID = uploadID;
					form.setUploadID(uploadID);
				} else {
					discardQuietly(uploadID);
				}
			} catch (err) {
				if (!owns()) return;
				form.setError(deps.formatError(err));
				form.setFileName('');
			} finally {
				operations.finish(operation);
			}
		},
		consume(uploadID: string): void {
			if (activeUploadID === uploadID) activeUploadID = '';
			if (mounted) consumedUploadIDs.add(uploadID);
			else discardQuietly(uploadID);
		},
		finishConsume(uploadID: string): void {
			discardConsumed(uploadID);
		},
		unmount(): void {
			mounted = false;
			operations.destroy();
			const uploadID = activeUploadID;
			if (uploadID) void discardActive(uploadID).catch(() => {});
			for (const consumedUploadID of consumedUploadIDs) discardConsumed(consumedUploadID, true);
		},
	};
}
