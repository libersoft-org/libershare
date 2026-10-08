import { readFileSync } from 'node:fs';
import { nativeBootUuid, type NativeProcessRead } from './process-identity.ts';

export interface LinuxProcessIdentityDeps {
	readonly read: (path: string) => string;
	readonly probe: (pid: number) => 'present' | 'absent' | 'unknown';
}

function errorCode(error: unknown): string | undefined {
	return error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

const linuxDeps: LinuxProcessIdentityDeps = {
	read: path => readFileSync(path, 'utf8'),
	probe: pid => {
		try {
			process.kill(pid, 0);
			return 'present';
		} catch (error) {
			return errorCode(error) === 'ESRCH' ? 'absent' : 'unknown';
		}
	},
};

export function readLinuxBootId(read: (path: string) => string = linuxDeps.read): string | null {
	return nativeBootUuid(read('/proc/sys/kernel/random/boot_id'), 'linux');
}

export function readLinuxProcessIdentity(pid: number, deps: LinuxProcessIdentityDeps = linuxDeps): NativeProcessRead {
	let stat: string;
	try {
		stat = deps.read(`/proc/${pid}/stat`);
	} catch (error) {
		// hidepid can report ENOENT for a living process; only ESRCH proves absence.
		return { state: errorCode(error) === 'ENOENT' && deps.probe(pid) === 'absent' ? 'ended' : 'unknown' };
	}
	const end = stat.lastIndexOf(')');
	if (!stat.startsWith(`${pid} (`) || end < 0 || stat[end + 1] !== ' ') return { state: 'unknown' };
	const fields = stat
		.slice(end + 2)
		.trim()
		.split(/\s+/);
	const started = fields[19];
	if (fields.length < 20 || !/^[RSDZTtWXxIKP]$/.test(fields[0]!) || started === undefined || !/^\d{1,20}$/.test(started) || BigInt(started) > 0xffffffffffffffffn) return { state: 'unknown' };
	if (fields[0] === 'Z' || fields[0] === 'X' || fields[0] === 'x') return { state: 'ended' };
	return { state: 'running', started: `linux-starttime:${BigInt(started)}` };
}
