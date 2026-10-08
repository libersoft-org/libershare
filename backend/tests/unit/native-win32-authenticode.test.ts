import { expect, test } from 'bun:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { windowsSystemDirectory } from '../../src/native/library.ts';
import { NativeWorkerChannel } from '../../src/native/worker-host.ts';
import { readAuthenticodeSignature, type AuthenticodeSignature } from '../../src/native/win32/authenticode.ts';

test('signature verification cannot block the main thread', () => {
	expect(() => readAuthenticodeSignature('C:\\example.exe')).toThrow('requires a worker');
});

test.skipIf(process.platform !== 'win32')(
	'WinTrust accepts a signed binary and rejects modified or unsigned copies',
	async () => {
		const directory = await mkdtemp(join(tmpdir(), 'native-authenticode-'));
		const channel = new NativeWorkerChannel('read');
		try {
			const signed = join(windowsSystemDirectory(), 'ntoskrnl.exe');
			const signature = await channel.call<AuthenticodeSignature>({ method: 'win32.signature', args: { path: signed } }, 30000);
			expect(signature.status).toBe(0);
			expect(signature.thumbprint).toMatch(/^[A-F0-9]{40}$/);
			expect(await channel.call<boolean>({ method: 'win32.signatures.match', args: { paths: [signed, signed, signed] } }, 30000)).toBe(true);
			const modified = join(directory, 'modified.exe');
			const bytes = await readFile(signed);
			// The PE checksum is excluded from Authenticode; modify the first code section instead.
			const pe = bytes.readUInt32LE(0x3c);
			const section = pe + 24 + bytes.readUInt16LE(pe + 20);
			const code = bytes.readUInt32LE(section + 20);
			bytes[code] = bytes[code]! ^ 1;
			await writeFile(modified, bytes);
			const changed = await channel.call<AuthenticodeSignature>({ method: 'win32.signature', args: { path: modified } }, 30000);
			expect(changed.status).not.toBe(0);
			expect(changed.thumbprint).toBeNull();
			const unsigned = join(directory, 'unsigned.exe');
			await writeFile(unsigned, 'unsigned test data');
			expect(await channel.call<boolean>({ method: 'win32.signatures.match', args: { paths: [signed, unsigned, signed] } }, 30000)).toBe(false);
		} finally {
			channel.close();
			await rm(directory, { recursive: true, force: true });
		}
	},
	90000
);
