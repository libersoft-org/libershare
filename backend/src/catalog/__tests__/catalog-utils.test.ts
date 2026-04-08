import { describe, test, expect } from 'bun:test';
import { computeManifestHash } from '../catalog-utils.ts';

describe('computeManifestHash', () => {
	test('produces deterministic sha256 hash', () => {
		const manifest = { id: 'test-lish', name: 'Test', chunkSize: 1024, files: [{ path: 'file.txt', size: 100 }] };
		const hash1 = computeManifestHash(manifest);
		const hash2 = computeManifestHash(manifest);
		expect(hash1).toBe(hash2);
		expect(hash1).toMatch(/^sha256:[a-f0-9]{64}$/);
	});

	test('different manifests produce different hashes', () => {
		const a = { id: 'a', name: 'A' };
		const b = { id: 'b', name: 'B' };
		expect(computeManifestHash(a)).not.toBe(computeManifestHash(b));
	});

	test('field order does not affect hash (canonical JSON)', () => {
		const a = { name: 'Test', id: '123' };
		const b = { id: '123', name: 'Test' };
		expect(computeManifestHash(a)).toBe(computeManifestHash(b));
	});

	test('nested objects are handled', () => {
		const manifest = {
			id: 'lish-1',
			files: [
				{ path: 'a.txt', size: 100, checksums: ['abc'] },
				{ path: 'b.txt', size: 200, checksums: ['def'] },
			],
		};
		const hash = computeManifestHash(manifest);
		expect(hash).toMatch(/^sha256:/);
	});
});
