import { describe, expect, it } from 'bun:test';
import { isFatalStorageError, fatalStorageMessage, FATAL_STORAGE_CODES } from '../../src/storage.ts';

describe('storage fatal-error classifier', () => {
	for (const code of FATAL_STORAGE_CODES) {
		it(`classifies ${code} as fatal`, () => {
			const err = Object.assign(new Error('boom'), { code });
			expect(isFatalStorageError(err)).toBe(true);
		});
	}

	it('does not classify ENOENT as fatal', () => {
		const err = Object.assign(new Error('not found'), { code: 'ENOENT' });
		expect(isFatalStorageError(err)).toBe(false);
	});

	it('does not classify a plain Error as fatal', () => {
		expect(isFatalStorageError(new Error('plain'))).toBe(false);
	});

	it('does not classify null/undefined as fatal', () => {
		expect(isFatalStorageError(null)).toBe(false);
		expect(isFatalStorageError(undefined)).toBe(false);
	});
});

describe('storage fatal-error message', () => {
	const fixture = '/app/config/settings.json';

	it('mentions the file path and code on every line block', () => {
		const lines = fatalStorageMessage(fixture, 'EACCES');
		expect(lines[0]).toContain(fixture);
		expect(lines[0]).toContain('EACCES');
		expect(lines.length).toBeGreaterThan(1);
	});

	it('includes the chown remediation hint for permission codes', () => {
		for (const code of ['EACCES', 'EROFS', 'EPERM'] as const) {
			const joined = fatalStorageMessage(fixture, code).join('\n');
			expect(joined).toContain('chown 0:0');
			expect(joined).toContain('cap_drop');
		}
	});

	it('uses a disk-full hint for ENOSPC instead of the chown hint', () => {
		const joined = fatalStorageMessage(fixture, 'ENOSPC').join('\n');
		expect(joined).toContain('full');
		expect(joined).not.toContain('chown 0:0');
	});

	it('uses a directory-clash hint for EISDIR', () => {
		const joined = fatalStorageMessage(fixture, 'EISDIR').join('\n');
		expect(joined).toContain('directory');
		expect(joined).not.toContain('chown 0:0');
	});
});
