import { describe, expect, it } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setWindowsGuiSubsystem } from '../../scripts/set-windows-gui-subsystem.ts';

function pe(subsystem: number): Buffer {
	const bytes = Buffer.alloc(512);
	bytes.write('MZ', 0, 'ascii');
	bytes.writeUInt32LE(0x80, 0x3c);
	bytes.write('PE\0\0', 0x80, 'ascii');
	bytes.writeUInt16LE(subsystem, 0xdc);
	return bytes;
}

describe('Windows executable subsystem build step', () => {
	it('changes a console executable to the GUI subsystem', () => {
		expect(Buffer.from(setWindowsGuiSubsystem(pe(3))).readUInt16LE(0xdc)).toBe(2);
	});

	it('keeps a GUI executable unchanged and rejects malformed inputs', () => {
		expect(Buffer.from(setWindowsGuiSubsystem(pe(2))).readUInt16LE(0xdc)).toBe(2);
		expect(() => setWindowsGuiSubsystem(Buffer.alloc(64))).toThrow('DOS');
		expect(() => setWindowsGuiSubsystem(pe(9))).toThrow('unsupported');
	});

	it.each([3, 9])('preserves the file payload when the CLI receives subsystem %i', subsystem => {
		const root = mkdtempSync(join(tmpdir(), 'lish-pe-subsystem-'));
		const path = join(root, 'payload.exe');
		const before = Buffer.concat([pe(subsystem), randomBytes(1024 * 1024)]);
		try {
			writeFileSync(path, before);
			const result = Bun.spawnSync([process.execPath, resolve(import.meta.dir, '../../scripts/set-windows-gui-subsystem.ts'), path], { timeout: 10_000 });
			expect(result.exitCode).toBe(subsystem === 3 ? 0 : 1);
			expect(readFileSync(path)).toEqual(subsystem === 3 ? Buffer.from(setWindowsGuiSubsystem(before)) : before);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
