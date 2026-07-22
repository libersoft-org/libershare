import { describe, it, expect } from 'bun:test';
import { Downloader } from '../../../src/protocol/downloader.ts';

/**
 * Unit tests for Downloader.removeNetwork: leaving one lishnet of a multi-network
 * download must drop that network from the set (so WANT broadcasts / topic probes
 * stop reaching it), while never emptying the set — the caller disables the whole
 * download when the last network is left.
 */

function makeDownloader(networkIDs: string[]): Downloader {
	const dl = Object.create(Downloader.prototype) as Downloader;
	(dl as any).networkIDs = [...networkIDs];
	(dl as any).originalNetworkIDs = [...networkIDs];
	return dl;
}

describe('Downloader.removeNetwork', () => {
	it('removes one network from a multi-network download', () => {
		const dl = makeDownloader(['net-a', 'net-b']);
		dl.removeNetwork('net-a');
		expect(dl.getNetworkIDs()).toEqual(['net-b']);
	});

	it('is a no-op when the network is the only one left', () => {
		const dl = makeDownloader(['net-b']);
		dl.removeNetwork('net-b');
		expect(dl.getNetworkIDs()).toEqual(['net-b']);
	});

	it('is a no-op for a network the download is not bound to', () => {
		const dl = makeDownloader(['net-a', 'net-b']);
		dl.removeNetwork('net-c');
		expect(dl.getNetworkIDs()).toEqual(['net-a', 'net-b']);
	});
});

describe('Downloader.addNetwork', () => {
	it('re-adds a network that was previously removed', () => {
		const dl = makeDownloader(['net-a', 'net-b']);
		dl.removeNetwork('net-a');
		expect(dl.getNetworkIDs()).toEqual(['net-b']);
		dl.addNetwork('net-a');
		expect(dl.getNetworkIDs()).toEqual(['net-b', 'net-a']);
	});

	it('is a no-op for a network never in the original set', () => {
		const dl = makeDownloader(['net-a', 'net-b']);
		dl.addNetwork('net-c');
		expect(dl.getNetworkIDs()).toEqual(['net-a', 'net-b']);
	});

	it('is a no-op when the network is already active', () => {
		const dl = makeDownloader(['net-a', 'net-b']);
		dl.addNetwork('net-a');
		expect(dl.getNetworkIDs()).toEqual(['net-a', 'net-b']);
	});
});

describe('Downloader.getOriginalNetworkIDs', () => {
	it('stays the full original set even after removeNetwork shrinks the active set', () => {
		const dl = makeDownloader(['net-a', 'net-b']);
		dl.removeNetwork('net-a');
		expect(dl.getNetworkIDs()).toEqual(['net-b']);
		// Resume-on-rejoin binds to this, so leaving+rejoining net-a can still resume.
		expect(dl.getOriginalNetworkIDs()).toEqual(['net-a', 'net-b']);
	});
});
