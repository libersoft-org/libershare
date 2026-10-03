import { FFIType, ptr } from 'bun:ffi';
import { isMainThread } from 'node:worker_threads';
import { loadSystemLibrary } from '../library.ts';
import { CoreFoundation } from './cf.ts';

export interface MacCodeIdentity {
	readonly team: string;
	readonly identifier: string;
}

function securityLibrary() {
	return loadSystemLibrary('/System/Library/Frameworks/Security.framework/Security', {
		SecStaticCodeCreateWithPath: { args: [FFIType.u64, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
		SecStaticCodeCheckValidity: { args: [FFIType.u64, FFIType.u32, FFIType.u64], returns: FFIType.i32 },
		SecCodeCopySigningInformation: { args: [FFIType.u64, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
	});
}

let security: ReturnType<typeof securityLibrary> | undefined;

export function readMacCodeIdentity(path: string, deep = false): MacCodeIdentity | null {
	if (isMainThread) throw new Error('Signature verification requires a worker');
	if (!path.startsWith('/') || path.includes('\0')) throw new Error('An absolute signature path is required');
	const cf = new CoreFoundation();
	try {
		const api = (security ??= securityLibrary()).symbols;
		const bytes = Buffer.from(path, 'utf8');
		const url = cf.own(cf.symbols.CFURLCreateFromFileSystemRepresentation(0n, ptr(bytes), bytes.length, false));
		const code = new BigUint64Array(1);
		const created = api.SecStaticCodeCreateWithPath(url, 0, ptr(code));
		if (code[0]) cf.own(code[0]);
		if (created !== 0 || !code[0]) return null;
		// Validate every architecture; bundles additionally validate nested code.
		if (api.SecStaticCodeCheckValidity(code[0], 1 | 16 | (deep ? 8 : 0), 0n) !== 0) return null;
		const info = new BigUint64Array(1);
		const copied = api.SecCodeCopySigningInformation(code[0], 2, ptr(info));
		if (info[0]) cf.own(info[0]);
		if (copied !== 0 || !info[0]) return null;
		const team = cf.symbols.CFDictionaryGetValue(info[0], cf.createString('teamid'));
		const identifier = cf.symbols.CFDictionaryGetValue(info[0], cf.createString('identifier'));
		if (!team || !identifier) return null;
		const result = { team: cf.string(team).trim(), identifier: cf.string(identifier).trim() };
		return result.team && result.identifier ? result : null;
	} finally {
		cf.close();
	}
}
