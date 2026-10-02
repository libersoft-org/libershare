import type { NativeProcessIdentity, NativeProcessObservation } from './mutation-proof.ts';
import { readLinuxBootId, readLinuxProcessIdentity } from './process-identity-linux.ts';
import { readDarwinBootId, readDarwinProcessIdentity } from './process-identity-darwin.ts';
import { readWindowsBootId, readWindowsProcessIdentity } from './process-identity-windows.ts';

export type NativeProcessRead = { readonly state: 'running'; readonly started: string } | { readonly state: 'ended' | 'unknown' };

export interface NativeIdentityBackend {
	readonly prefix: string;
	readonly bootId: () => string | null;
	readonly process: (pid: number) => NativeProcessRead;
}

function platformBackend(): NativeIdentityBackend {
	switch (process.platform) {
		case 'linux':
			return { prefix: 'linux-starttime:', bootId: readLinuxBootId, process: readLinuxProcessIdentity };
		case 'darwin':
			return { prefix: 'darwin-uniqueid:', bootId: readDarwinBootId, process: readDarwinProcessIdentity };
		case 'win32':
			return { prefix: 'win32-filetime:', bootId: readWindowsBootId, process: readWindowsProcessIdentity };
		default:
			return { prefix: '', bootId: () => null, process: () => ({ state: 'unknown' }) };
	}
}

export function nativeBootUuid(value: string, platform: 'linux' | 'darwin'): string | null {
	const uuid = value.trim();
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid) ? `${platform}-boot:${uuid.toLowerCase()}` : null;
}

export function getNativeBootId(backend: NativeIdentityBackend = platformBackend()): string | null {
	try {
		return backend.bootId();
	} catch {
		// Missing native APIs or inaccessible kernel state are not proof of a reboot.
		return null;
	}
}

export function currentNativeProcessIdentity(backend: NativeIdentityBackend = platformBackend()): NativeProcessIdentity {
	const result = backend.process(process.pid);
	if (result.state !== 'running') throw new Error('Cannot establish current native process identity');
	return { pid: process.pid, started: result.started };
}

export function nativeProcessIdentity(pid: number, backend: NativeIdentityBackend = platformBackend()): NativeProcessIdentity | null {
	if (!Number.isInteger(pid) || pid <= 0 || pid > 0x7fffffff) return null;
	try {
		const result = backend.process(pid);
		return result.state === 'running' ? { pid, started: result.started } : null;
	} catch {
		return null;
	}
}

export function observeNativeProcess(identity: NativeProcessIdentity, backend: NativeIdentityBackend = platformBackend()): NativeProcessObservation {
	const value = identity.started.slice(backend.prefix.length);
	if (!Number.isInteger(identity.pid) || identity.pid <= 0 || identity.pid > 0x7fffffff || !backend.prefix || !identity.started.startsWith(backend.prefix) || !/^(0|[1-9]\d{0,19})$/.test(value)) return { identity, state: 'unknown' };
	if (BigInt(value) > 0xffffffffffffffffn || (value === '0' && backend.prefix !== 'linux-starttime:')) return { identity, state: 'unknown' };
	try {
		const result = backend.process(identity.pid);
		return { identity, state: result.state === 'running' ? (result.started === identity.started ? 'running' : 'ended') : result.state };
	} catch {
		// A failed observation cannot establish that native work has stopped.
		return { identity, state: 'unknown' };
	}
}
