import { CodedError, ErrorCodes, type ILISH } from '@shared';
import type { DatasetRoot, SafeDataset, openDataset } from './safe-dataset-files.ts';

interface Preparation {
	dataset: Promise<SafeDataset>;
	writers: number;
	retired: boolean;
	prepared: boolean;
	closing?: Promise<void>;
}

/** One immutable manifest and local root per download run; file handles still reopen on every write. */
export class DatasetWriteScope {
	private manifest: ILISH | undefined;
	private rootKey: string | undefined;
	private rootIdentity: string | undefined;
	private current: Preparation | undefined;
	private readonly preparations = new Set<Preparation>();
	private readonly pending = new Set<Promise<void>>();
	private closed = false;
	private closing: Promise<void> | undefined;

	write(root: DatasetRoot, manifest: ILISH, open: typeof openDataset, operation: (dataset: SafeDataset) => Promise<void>): Promise<void> {
		if (this.closed) return Promise.reject(Object.assign(new Error('Dataset writer is closed'), { code: 'EBADF' }));
		const key = root.kind === 'explicit' ? JSON.stringify([root.kind, root.path]) : JSON.stringify([root.kind, root.base, root.component]);
		if (this.manifest && (this.manifest !== manifest || this.rootKey !== key)) return Promise.reject(new CodedError(ErrorCodes.LISH_UNSAFE_PATH, 'Dataset writer cannot change its manifest or root'));
		this.manifest = manifest;
		this.rootKey = key;
		if (!this.current) {
			const selected = { ...root };
			const dataset = (async () => {
				const opened = await open(selected);
				try {
					const identity = (await opened.statDirectory())?.identity;
					if (!identity || (this.rootIdentity !== undefined && this.rootIdentity !== identity)) throw new CodedError(ErrorCodes.LISH_UNSAFE_PATH, 'Dataset root was replaced during recovery');
					this.rootIdentity = identity;
					await opened.prepare(manifest);
					return opened;
				} catch (error) {
					await opened.close();
					throw error;
				}
			})();
			this.current = { dataset, writers: 0, retired: false, prepared: false };
			this.preparations.add(this.current);
		}
		const preparation = this.current;
		preparation.writers++;
		const pending = (async () => {
			try {
				const dataset = await preparation.dataset;
				preparation.prepared = true;
				await operation(dataset);
			} catch (error) {
				// Controlled ENOENT recovery may allocate new files. Never renew on an identity mismatch.
				const code = (error as NodeJS.ErrnoException).code;
				if (code === 'ENOENT' || (!preparation.prepared && ['EACCES', 'EPERM', 'EROFS', 'ENOSPC'].includes(code ?? ''))) {
					preparation.retired = true;
					if (this.current === preparation) this.current = undefined;
				}
				throw error;
			} finally {
				preparation.writers--;
				if (preparation.retired && preparation.writers === 0) await this.dispose(preparation);
			}
		})();
		this.pending.add(pending);
		void pending.then(
			() => this.pending.delete(pending),
			() => this.pending.delete(pending)
		);
		return pending;
	}

	private dispose(preparation: Preparation): Promise<void> {
		return (preparation.closing ??= preparation.dataset
			.then(
				dataset => dataset.close(),
				() => {}
			)
			.finally(() => this.preparations.delete(preparation)));
	}

	close(): Promise<void> {
		this.closed = true;
		return (this.closing ??= (async () => {
			await Promise.allSettled([...this.pending]);
			await Promise.all([...this.preparations].map(preparation => this.dispose(preparation)));
		})());
	}
}
