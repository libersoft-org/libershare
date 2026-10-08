import { FFIType, ptr, read, type Pointer } from 'bun:ffi';
import { win32 } from 'node:path';
import { isMainThread } from 'node:worker_threads';
import { loadSystemLibrary } from '../library.ts';
import { guidBytes } from './com.ts';

export interface AuthenticodeSignature {
	readonly status: number;
	readonly thumbprint: string | null;
}

function libraries() {
	return {
		trust: loadSystemLibrary('wintrust.dll', {
			WinVerifyTrust: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
			WTHelperProvDataFromStateData: { args: [FFIType.ptr], returns: FFIType.ptr },
			WTHelperGetProvSignerFromChain: { args: [FFIType.ptr, FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
		}),
		certificates: loadSystemLibrary('crypt32.dll', {
			CertGetCertificateContextProperty: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
		}),
	};
}

let loaded: ReturnType<typeof libraries> | undefined;

/** Embedded Authenticode signature; trust-provider state owns the signer certificate. */
export function readAuthenticodeSignature(path: string): AuthenticodeSignature {
	if (isMainThread) throw new Error('Signature verification requires a worker');
	if (!win32.isAbsolute(path) || path.includes('\0')) throw new Error('An absolute signature path is required');
	const { trust, certificates } = (loaded ??= libraries());
	const action = guidBytes('00aac56b-cd44-11d0-8cc2-00c04fc295ee');
	const filename = Buffer.from(`${path}\0`, 'utf16le');
	const file = new Uint8Array(32);
	const fileView = new DataView(file.buffer);
	fileView.setUint32(0, file.byteLength, true);
	fileView.setBigUint64(8, BigInt(ptr(filename)), true);
	const data = new Uint8Array(88);
	const view = new DataView(data.buffer);
	view.setUint32(0, data.byteLength, true);
	view.setUint32(24, 2, true); // WTD_UI_NONE
	view.setUint32(32, 1, true); // WTD_CHOICE_FILE; revocation remains WTD_REVOKE_NONE.
	view.setBigUint64(40, BigInt(ptr(file)), true);
	view.setUint32(48, 1, true); // WTD_STATEACTION_VERIFY
	try {
		const status = trust.symbols.WinVerifyTrust(null, ptr(action), ptr(data)) >>> 0;
		let thumbprint: string | null = null;
		const state = view.getBigUint64(56, true);
		if (status === 0 && state) {
			const provider = trust.symbols.WTHelperProvDataFromStateData(Number(state) as Pointer);
			const signer = provider ? trust.symbols.WTHelperGetProvSignerFromChain(provider, 0, 0, 0) : null;
			if (signer && read.u32(signer, 12) > 0) {
				const chain = read.ptr(signer, 16) as Pointer;
				const certificate = chain ? (read.ptr(chain, 8) as Pointer) : null;
				const hash = new Uint8Array(20);
				const length = new Uint32Array([hash.length]);
				if (certificate && certificates.symbols.CertGetCertificateContextProperty(certificate, 3, ptr(hash), ptr(length)) && length[0] === hash.length) thumbprint = Buffer.from(hash).toString('hex').toUpperCase();
			}
		}
		return { status, thumbprint };
	} finally {
		view.setUint32(48, 2, true); // WTD_STATEACTION_CLOSE, including failed verification.
		trust.symbols.WinVerifyTrust(null, ptr(action), ptr(data));
	}
}

export function matchingAuthenticodeSignatures(paths: readonly string[]): boolean {
	if (paths.length !== 3) throw new Error('The backend, helper and launcher must be verified together');
	let expected: string | null = null;
	for (const path of paths) {
		const signature = readAuthenticodeSignature(path);
		if (signature.status !== 0 || !signature.thumbprint || (expected !== null && signature.thumbprint !== expected)) return false;
		expected = signature.thumbprint;
	}
	return true;
}
