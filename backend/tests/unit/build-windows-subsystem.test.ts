import { describe, expect, it } from 'bun:test';
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
});
