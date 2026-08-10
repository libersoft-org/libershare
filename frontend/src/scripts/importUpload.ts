/**
 * Upload sequencing for the import form's file picker.
 *
 * The picker stays reachable while an upload runs — the busy dialog blocks the
 * mouse but registers no navigation area, so keyboard and gamepad input still
 * reach the button. Two picks can therefore overlap, and the slower one must not
 * win: it would leave the form pointing at a file the user is no longer looking
 * at, strand its own copy on the backend's disk, and clear the busy label while
 * the newer transfer is still running.
 *
 * Extracted from the component so the race is unit-testable; the component keeps
 * every piece of form state and passes it in through {@link ImportUploadForm}.
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
	/** Run one file pick. Resolves once this pick is done, won or lost. */
	pick: (file: File) => Promise<void>;
	/** The form is gone — no pick owns its state any more. */
	unmount: () => void;
}

/** What an import must do with the temp copy it consumed, once parsing has ended. */
export interface ImportCleanup {
	/** The temp path to delete — always the one that was parsed, never the current state. */
	discard: string;
	/** Whether the form still shows that file, and so may be cleared. */
	clearForm: boolean;
}

/**
 * Decide the cleanup for an import that has finished parsing `parsed`.
 *
 * The picker stays reachable while the import runs, so by the time parsing ends the
 * form may already hold a newer pick. The copy to delete is the one this import
 * consumed; the fields may only be cleared if they still describe it, otherwise the
 * import would wipe a file the user has just chosen.
 */
export function importCleanup(parsed: string, current: string): ImportCleanup {
	return { discard: parsed, clearForm: current === parsed };
}

/**
 * Sequence file picks so only the newest one may write to the form.
 * A pick that has been superseded, or whose form has been destroyed, discards the
 * copy it uploaded instead of handing it to a form that no longer wants it.
 */
export function createImportUploader(form: ImportUploadForm, deps: ImportUploadDeps): ImportUploader {
	let newest = 0;
	let mounted = true;
	return {
		async pick(file: File): Promise<void> {
			// Whatever the form already holds is abandoned the moment a new file is
			// picked. A pick still in flight has no path yet — its own `owns()` check
			// below is what stops it from stranding a copy.
			const held = form.getPath();
			if (held) deps.discard(held);
			const token = ++newest;
			const owns = (): boolean => mounted && token === newest;
			form.setPath('');
			form.setFileName(file.name);
			form.setError('');
			form.setBusy(deps.uploadingLabel());
			try {
				// The file goes to the backend as-is and is parsed there from its path.
				// Reading it here would also mean decompressing it here, and the browser
				// only knows gzip and deflate — a .br or .zst upload has no chance.
				const path = await deps.upload(file);
				// Superseded by a later pick, or the form is gone: nobody is left to
				// import or delete this file, so drop it here instead.
				if (owns()) form.setPath(path);
				else deps.discard(path);
			} catch (err) {
				if (!owns()) return;
				form.setError(deps.formatError(err));
				form.setFileName('');
			} finally {
				// Only the newest pick owns the busy label; an older one clearing it
				// would hide an upload that is still running.
				if (owns()) form.setBusy('');
			}
		},
		unmount(): void {
			mounted = false;
		},
	};
}
