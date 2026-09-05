import { readFileSync, writeFileSync } from 'node:fs';

export function setWindowsGuiSubsystem(input: Uint8Array): Uint8Array {
	const bytes = Buffer.from(input);
	if (bytes.length < 0x40 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) throw new Error('invalid PE DOS header');
	const peOffset = bytes.readUInt32LE(0x3c);
	const subsystemOffset = peOffset + 0x5c;
	if (peOffset < 0x40 || subsystemOffset + 2 > bytes.length || bytes.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') throw new Error('invalid PE header');
	const subsystem = bytes.readUInt16LE(subsystemOffset);
	if (subsystem !== 2 && subsystem !== 3) throw new Error(`unsupported PE subsystem ${subsystem}`);
	bytes.writeUInt16LE(2, subsystemOffset);
	return bytes;
}

if (import.meta.main) {
	const path = process.argv[2];
	if (!path || process.argv.length !== 3) throw new Error('expected one PE path');
	writeFileSync(path, setWindowsGuiSubsystem(readFileSync(path)));
}
