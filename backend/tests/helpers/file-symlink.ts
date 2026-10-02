import { it } from 'bun:test';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function unavailableReason(): string | null {
	const dir = mkdtempSync(join(tmpdir(), 'lish-symlink-probe-'));
	try {
		const target = join(dir, 'target');
		writeFileSync(target, 'probe');
		try {
			symlinkSync(target, join(dir, 'link'), 'file');
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (process.platform === 'win32' && code === 'EPERM') return 'Windows denied file symlink creation (EPERM)';
			if (code === 'ENOSYS' || code === 'ENOTSUP' || code === 'EOPNOTSUPP') return `file symlink creation is unsupported (${code})`;
			throw error;
		}
		return null;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const skipReason = unavailableReason();

/** Register an explicit skip only when the temporary filesystem cannot create file symlinks. */
export function itWithFileSymlinks(name: string, test: () => void | Promise<void>): void {
	it.skipIf(skipReason !== null)(skipReason ? `${name} [${skipReason}]` : name, test);
}
