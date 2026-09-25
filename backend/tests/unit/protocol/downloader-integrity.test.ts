import { describe, it, expect, beforeEach } from 'bun:test';
import { Downloader } from '../../../src/protocol/downloader.ts';
import { MockNetwork } from '../helpers/mock-network.ts';
import { MockDataServer } from './downloader-test-helpers.ts';
// ---------------------------------------------------------------------------
// Path traversal protection (safePath)
// ---------------------------------------------------------------------------

describe('Downloader – path traversal protection', () => {
	let ds: MockDataServer;
	let net: MockNetwork;

	beforeEach(() => {
		ds = new MockDataServer();
		net = new MockNetwork();
	});

	function makeDownloader(downloadDir = '/tmp/safe-downloads/12345'): Downloader {
		return new Downloader(downloadDir, net as never, ds as never, 'net-001');
	}

	function callSafePath(downloader: Downloader, relativePath: string): string {
		const fa = (downloader as unknown as { fileAllocator: { safePath: (p: string) => string } }).fileAllocator;
		return fa.safePath(relativePath);
	}

	// --- Legitimate paths (should pass) ---

	it('allows simple filename', () => {
		const dl = makeDownloader();
		expect(() => callSafePath(dl, 'movie.mkv')).not.toThrow();
	});

	it('allows nested path', () => {
		const dl = makeDownloader();
		expect(() => callSafePath(dl, 'video/movie.mkv')).not.toThrow();
	});

	it('allows deeply nested path', () => {
		const dl = makeDownloader();
		expect(() => callSafePath(dl, 'a/b/c/d/e/file.txt')).not.toThrow();
	});

	it('allows path with spaces', () => {
		const dl = makeDownloader();
		expect(() => callSafePath(dl, 'my folder/my file.txt')).not.toThrow();
	});

	it('allows path with unicode characters', () => {
		const dl = makeDownloader();
		expect(() => callSafePath(dl, 'složka/soubor-čěšřž.txt')).not.toThrow();
	});

	// --- Basic traversal attacks (must block) ---

	it('blocks ../ at start', () => {
		const dl = makeDownloader();
		expect(() => callSafePath(dl, '../evil.txt')).toThrow('Path traversal blocked');
	});

	it('blocks ../../ double traversal', () => {
		const dl = makeDownloader();
		expect(() => callSafePath(dl, '../../evil.txt')).toThrow('Path traversal blocked');
	});

	it('blocks ../../../ triple traversal', () => {
		const dl = makeDownloader();
		expect(() => callSafePath(dl, '../../../etc/passwd')).toThrow('Path traversal blocked');
	});

	it('blocks ../ in middle of path', () => {
		const dl = makeDownloader();
		expect(() => callSafePath(dl, 'subdir/../../evil.txt')).toThrow('Path traversal blocked');
	});

	it('blocks deeply nested traversal that escapes', () => {
		const dl = makeDownloader();
		expect(() => callSafePath(dl, 'a/b/c/../../../../evil.txt')).toThrow('Path traversal blocked');
	});

	// --- Encoded/obfuscated traversal attempts (must block) ---

	it('blocks backslash traversal on Windows', () => {
		const dl = makeDownloader();
		expect(() => callSafePath(dl, '..\\evil.txt')).toThrow('Path traversal blocked');
	});

	it('blocks mixed slash traversal', () => {
		const dl = makeDownloader();
		expect(() => callSafePath(dl, '..\\..\\evil.txt')).toThrow('Path traversal blocked');
	});

	// --- Boundary: traversal that stays inside (should pass) ---

	it('allows subdir/../same-level (stays inside downloadDir)', () => {
		const dl = makeDownloader();
		// subdir/../file.txt resolves to downloadDir/file.txt — still inside
		expect(() => callSafePath(dl, 'subdir/../file.txt')).not.toThrow();
	});

	it('allows a/b/../b/file.txt (stays inside downloadDir)', () => {
		const dl = makeDownloader();
		expect(() => callSafePath(dl, 'a/b/../b/file.txt')).not.toThrow();
	});

	// --- Targeted attack scenarios ---

	it('blocks settings.json overwrite attack', () => {
		const dl = makeDownloader('/app/data/downloads/12345');
		expect(() => callSafePath(dl, '../../settings.json')).toThrow('Path traversal blocked');
	});

	it('blocks .ssh/authorized_keys attack', () => {
		const dl = makeDownloader('/home/user/libershare/downloads/12345');
		expect(() => callSafePath(dl, '../../../../../.ssh/authorized_keys')).toThrow('Path traversal blocked');
	});

	it('blocks /etc/passwd attack via deep traversal', () => {
		const dl = makeDownloader('/app/data/downloads/12345');
		expect(() => callSafePath(dl, '../../../../../../etc/passwd')).toThrow('Path traversal blocked');
	});

	it('blocks database overwrite attack', () => {
		const dl = makeDownloader('/app/.node1/downloads/12345');
		expect(() => callSafePath(dl, '../../libershare.db')).toThrow('Path traversal blocked');
	});

	// --- Absolute path injection (must block) ---

	it('blocks absolute path on Unix', () => {
		const dl = makeDownloader('/tmp/safe');
		expect(() => callSafePath(dl, '/etc/passwd')).toThrow('Path traversal blocked');
	});

	// --- Edge cases ---

	it('blocks bare ..', () => {
		const dl = makeDownloader();
		expect(() => callSafePath(dl, '..')).toThrow('Path traversal blocked');
	});

	it('blocks empty-segment traversal /../', () => {
		const dl = makeDownloader();
		expect(() => callSafePath(dl, './../evil')).toThrow('Path traversal blocked');
	});

	it('allows ./file.txt', () => {
		const dl = makeDownloader();
		expect(() => callSafePath(dl, './file.txt')).not.toThrow();
	});
});
