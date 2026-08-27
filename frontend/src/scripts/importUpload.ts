/** State one file pick drives in the import form. */
export interface ImportUploadForm {
	getUploadID: () => string;
	setUploadID: (uploadID: string) => void;
	setFileName: (name: string) => void;
	setError: (message: string) => void;
	setBusy: (label: string) => void;
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
	/** Stop treating an upload as discardable because the parser now owns it. */
	consume: (uploadID: string) => void;
	unmount: () => void;
}

/**
 * Whether an import still owns the form after its asynchronous parse finishes.
 * A mode change or a newer selection means the old result must not overwrite the
 * state the user is now looking at.
 */
export function importOwnsForm(parsingUpload: boolean, currentUploadMode: boolean, currentSelection: string, parsing: string): boolean {
	return parsingUpload === currentUploadMode && currentSelection === parsing;
}

/**
 * Sequence file picks so only the newest one can update the form. Upload ids are
 * recorded as soon as `upload.begin` succeeds, allowing a later pick or unmount
 * to abort a transfer that has not reached `upload.end` yet.
 */
export function createImportUploader(form: ImportUploadForm, deps: ImportUploadDeps): ImportUploader {
	let newest = 0;
	let mounted = true;
	let activeUploadID = '';
	let cleanup: { uploadID: string; promise: Promise<void> } | null = null;

	function discardQuietly(uploadID: string): void {
		void deps.discard(uploadID).catch(() => {});
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
			const token = ++newest;
			const owns = (): boolean => mounted && token === newest;
			const previous = activeUploadID;
			form.setUploadID('');
			form.setFileName(file.name);
			form.setError('');
			form.setBusy(deps.uploadingLabel());
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
				if (owns()) form.setBusy('');
			}
		},
		consume(uploadID: string): void {
			if (activeUploadID === uploadID) activeUploadID = '';
		},
		unmount(): void {
			mounted = false;
			newest++;
			const uploadID = activeUploadID;
			if (uploadID) void discardActive(uploadID).catch(() => {});
		},
	};
}
