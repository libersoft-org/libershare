import { describe, expect, it } from 'bun:test';
import { isLocalClientAddress } from '../../../src/api/api.ts';
import { initFsHandlers } from '../../../src/api/fs.ts';

describe('local filesystem client detection', () => {
	const localAddresses = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', '192.0.2.10']);

	it('recognises loopback and host-interface clients as local', () => {
		for (const address of localAddresses) expect(isLocalClientAddress(address, localAddresses)).toBe(true);
	});

	it('keeps remote clients away from the host filesystem', async () => {
		expect(isLocalClientAddress('198.51.100.25', localAddresses)).toBe(false);
		const info = await initFsHandlers(async () => false).info({}, { data: { isLocalClient: false } });
		expect(info.localFilesystem).toBe(false);
	});

	it('keeps the host filesystem disabled inside a container', async () => {
		const client = { data: { isLocalClient: true } };
		expect((await initFsHandlers(async () => true).info({}, client)).localFilesystem).toBe(false);
		expect((await initFsHandlers(async () => false).info({}, client)).localFilesystem).toBe(true);
	});
});
