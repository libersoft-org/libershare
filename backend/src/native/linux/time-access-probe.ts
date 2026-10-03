import { FFIType, ptr, read } from 'bun:ffi';
import { selfProcessCommand } from '../self-process.ts';
import { loadSystemLibrary } from '../library.ts';
import { resolveForServiceAccount } from '../../system-time-files.ts';
import { TIMESYNCD_DROPIN_PATH } from '../../system-time-linux.ts';
import { remainingSaveBudget } from '../../system-time-common.ts';
import type { NativeTimeServiceIdentity } from './time-mutation-nss.ts';

export interface TimeAccessProbeRequest extends NativeTimeServiceIdentity {
	readonly path: string;
	readonly mode: 'r' | 'x';
}

function validRequest(value: unknown): value is TimeAccessProbeRequest {
	if (!value || typeof value !== 'object') return false;
	const request = value as TimeAccessProbeRequest;
	const id = (value: unknown): boolean => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xfffffffe;
	return Object.keys(request).every(key => ['uid', 'gid', 'groups', 'path', 'mode'].includes(key)) && id(request.uid) && id(request.gid) && Array.isArray(request.groups) && request.groups.length <= 65536 && request.groups.every(id) && typeof request.path === 'string' && request.path.startsWith('/') && !request.path.includes('\0') && ['r', 'x'].includes(request.mode);
}

export interface TimeAccessSyscalls {
	setgroups(groups: readonly number[]): number;
	setresgid(gid: number): number;
	setresuid(uid: number): number;
	access(path: string, mode: 'r' | 'x'): { result: number; errno: number };
}

/** No access check runs after a failed privilege drop. */
export function executeTimeAccessProbe(request: TimeAccessProbeRequest, calls: TimeAccessSyscalls): number {
	if (!validRequest(request)) return 3;
	if (calls.setgroups(request.groups) !== 0 || calls.setresgid(request.gid) !== 0 || calls.setresuid(request.uid) !== 0) return 3;
	const answer = calls.access(request.path, request.mode);
	return answer.result === 0 ? 0 : [1, 13].includes(answer.errno) ? 1 : 4;
}

/** Entry point for the dedicated child, before normal app/helper initialization. */
export async function runTimeAccessProbeArgument(encoded: string): Promise<number> {
	if (process.platform !== 'linux' || process.getuid?.() !== 0 || typeof encoded !== 'string' || encoded.length > 1024 * 1024) return 3;
	let request: unknown;
	try { request = JSON.parse(encoded); } catch { return 3; }
	if (!validRequest(request)) return 3;
	const resolution = await resolveForServiceAccount(TIMESYNCD_DROPIN_PATH);
	const allowed = new Set([...resolution.traversed, resolution.target, resolution.directory].filter((path): path is string => path !== null));
	if (!allowed.has(request.path)) return 3;
	const libc = loadSystemLibrary('libc.so.6', {
		setgroups: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 }, setresgid: { args: [FFIType.u32, FFIType.u32, FFIType.u32], returns: FFIType.i32 }, setresuid: { args: [FFIType.u32, FFIType.u32, FFIType.u32], returns: FFIType.i32 }, access: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 }, __errno_location: { args: [], returns: FFIType.ptr },
	});
	try {
		return executeTimeAccessProbe(request, {
			setgroups: groups => { const values = new Uint32Array(groups); return libc.symbols.setgroups(BigInt(values.length), values.length ? ptr(values) : null); },
			setresgid: gid => libc.symbols.setresgid(gid, gid, gid), setresuid: uid => libc.symbols.setresuid(uid, uid, uid),
			access: (path, mode) => { const value = Buffer.from(`${path}\0`); const result = libc.symbols.access(ptr(value), mode === 'r' ? 4 : 1); return { result, errno: result === 0 ? 0 : read.i32(libc.symbols.__errno_location()!) }; },
		});
	} finally { libc.close(); }
}

export function timeAccessProbeCommand(request: TimeAccessProbeRequest): string[] {
	if (!validRequest(request)) throw new Error('Invalid time service access request');
	return selfProcessCommand('--access-probe', JSON.stringify(request));
}

export async function probeNativeTimeServiceAccess(request: TimeAccessProbeRequest): Promise<boolean | { unknown: string }> {
	const timeoutMs = Math.min(5000, remainingSaveBudget() ?? 5000);
	if (timeoutMs <= 0) return { unknown: 'The time service access check exceeded its budget' };
	try {
		const child = Bun.spawn(timeAccessProbeCommand(request), { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
		const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
		try { const status = await child.exited; return status === 0 ? true : status === 1 ? false : { unknown: 'The kernel access check for the time service could not be completed' }; }
		finally { clearTimeout(timer); }
	} catch { return { unknown: 'The time service access probe could not be started' }; }
}
