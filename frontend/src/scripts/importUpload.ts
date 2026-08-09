/**
 * File-pick handling for the import form.
 *
 * Extracted from the component so the upload's ownership rules can be
 * unit-tested; the component keeps every piece of form state and passes it in
 * through {@link ImportUploadForm}.
 */

/** The form state one file pick drives. The component maps these onto its runes. */
export interface ImportUploadForm {
	/** Temp path of the upload the form currently holds; empty when it holds none. */
	getPath: () => string;
	setPath: (path: string) => void;
	setFileName: (name: string) => void;
	setError: (message: string) => void;
	/** Label of the blocking dialog; empty hides it. */
	setBusy: (label: string) => void;
}

/** Everything the sequencer needs from the outside world. */
export interface ImportUploadDeps {
	/** Sends the picked file to the backend and resolves with its temp path. */
	upload: (file: File) => Promise<string>;
	/** Drops a backend temp file nobody owns any more. Must not throw. */
	discard: (path: string) => void;
	/** Translated label for the uploading state, read per pick so a language switch lands. */
	uploadingLabel: () => string;
	/** Renders an upload failure for the user. */
	formatError: (err: unknown) => string;
}

/** Handle returned by {@link createImportUploader}. */
export interface ImportUploader {
	/** Run one file pick. Resolves once the pick is done. */
	pick: (file: File) => Promise<void>;
	/** The form is gone — no pick owns its state any more. */
	unmount: () => void;
}

/** Drive file picks for the import form. */
export function createImportUploader(form: ImportUploadForm, deps: ImportUploadDeps): ImportUploader {
	let mounted = true;
	return {
		async pick(file: File): Promise<void> {
			// Picking a second file abandons the first one on the backend's disk.
			const held = form.getPath();
			if (held) deps.discard(held);
			form.setPath('');
			form.setFileName(file.name);
			form.setError('');
			form.setBusy(deps.uploadingLabel());
			try {
				// The file goes to the backend as-is and is parsed there from its path.
				// Reading it here would also mean decompressing it here, and the browser
				// only knows gzip and deflate — a .br or .zst upload has no chance.
				const path = await deps.upload(file);
				// The form can be closed mid-upload; the file that lands afterwards has
				// nobody left to import or delete it, so drop it here instead.
				if (mounted) form.setPath(path);
				else deps.discard(path);
			} catch (err) {
				form.setError(deps.formatError(err));
				form.setFileName('');
			} finally {
				form.setBusy('');
			}
		},
		unmount(): void {
			mounted = false;
		},
	};
}
