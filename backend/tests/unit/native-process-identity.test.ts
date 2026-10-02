import { describe, expect, test } from 'bun:test';
import { currentNativeProcessIdentity, getNativeBootId, nativeBootUuid, observeNativeProcess, type NativeIdentityBackend } from '../../src/native/process-identity.ts';
import { readLinuxBootId, readLinuxProcessIdentity, type LinuxProcessIdentityDeps } from '../../src/native/process-identity-linux.ts';
import { readWindowsProcessIdentity, type WindowsProcessIdentityApi } from '../../src/native/process-identity-windows.ts';
import { readDarwinProcessIdentity } from '../../src/native/process-identity-darwin.ts';

const UUID = '12345678-1234-4321-ABCD-123456789ABC';

describe('native process observation', () => {
	const identity = { pid: 123, started: 'linux-starttime:400' };
	const backend: NativeIdentityBackend = { prefix: 'linux-starttime:', bootId: () => `linux-boot:${UUID.toLowerCase()}`, process: () => ({ state: 'running', started: identity.started }) };

	test('compares the process generation rather than PID alone', () => {
		expect(observeNativeProcess(identity, backend)).toEqual({ identity, state: 'running' });
		expect(observeNativeProcess(identity, { ...backend, process: () => ({ state: 'running', started: 'linux-starttime:401' }) })).toEqual({ identity, state: 'ended' });
	});

	test('retains the original identity in confirmed and inconclusive results', () => {
		for (const state of ['ended', 'unknown'] as const) expect(observeNativeProcess(identity, { ...backend, process: () => ({ state }) })).toEqual({ identity, state });
		expect(
			observeNativeProcess(identity, {
				...backend,
				process: () => {
					throw new Error('native API inaccessible');
				},
			}).state
		).toBe('unknown');
	});

	test('does not use an incompatible or malformed identity as evidence', () => {
		for (const invalid of [
			{ ...identity, pid: -1 },
			{ ...identity, pid: 0 },
			{ ...identity, pid: 2147483648 },
			{ ...identity, started: 'win32-filetime:400' },
			{ ...identity, started: 'linux-starttime:0400' },
			{ ...identity, started: 'linux-starttime:' },
			{ ...identity, started: 'linux-starttime:18446744073709551616' },
		])
			expect(observeNativeProcess(invalid, backend).state).toBe('unknown');
	});

	test('refuses to invent a current-process identity', () => {
		expect(currentNativeProcessIdentity(backend)).toEqual({ pid: process.pid, started: identity.started });
		for (const state of ['ended', 'unknown'] as const) expect(() => currentNativeProcessIdentity({ ...backend, process: () => ({ state }) })).toThrow('identity');
	});

	test('leaves unreadable boot identities unknown', () => {
		expect(getNativeBootId(backend)).toBe(`linux-boot:${UUID.toLowerCase()}`);
		expect(getNativeBootId({ ...backend, bootId: () => null })).toBeNull();
		expect(
			getNativeBootId({
				...backend,
				bootId: () => {
					throw new Error('permission denied');
				},
			})
		).toBeNull();
		expect(nativeBootUuid(`${UUID}\n`, 'darwin')).toBe(`darwin-boot:${UUID.toLowerCase()}`);
		for (const invalid of ['', '123', `${UUID}\0`, '2026-01-01T00:00:00Z']) expect(nativeBootUuid(invalid, 'linux')).toBeNull();
	});
});

describe('Linux procfs evidence', () => {
	function stat(state: string = 'S', started: string = '12345678901234567890'): string {
		return `123 (test ) name\nwith (parens)) ${state} ${Array(18).fill('0').join(' ')} ${started} 0 0\n`;
	}
	const deps: LinuxProcessIdentityDeps = { read: () => stat(), probe: () => 'present' };

	test('reads field 22 without losing precision or splitting the process name', () => {
		expect(readLinuxProcessIdentity(123, deps)).toEqual({ state: 'running', started: 'linux-starttime:12345678901234567890' });
	});

	test('requires ESRCH after ENOENT, including hidden procfs entries', () => {
		const missing = () => {
			throw Object.assign(new Error('missing'), { code: 'ENOENT' });
		};
		for (const probe of ['present', 'unknown', 'absent'] as const) expect(readLinuxProcessIdentity(123, { read: missing, probe: () => probe }).state).toBe(probe === 'absent' ? 'ended' : 'unknown');
	});

	test('does not reinterpret access or input failures as process death', () => {
		for (const code of ['EACCES', 'EPERM', 'EIO'])
			expect(
				readLinuxProcessIdentity(123, {
					read: () => {
						throw Object.assign(new Error(code), { code });
					},
					probe: () => 'absent',
				}).state
			).toBe('unknown');
		for (const text of ['123 (truncated)', stat('Q'), stat('S', '-1'), stat().replace('123 (', '124 (')]) expect(readLinuxProcessIdentity(123, { ...deps, read: () => text }).state).toBe('unknown');
	});

	test('recognizes zombies as executors that can no longer run', () => {
		for (const state of ['Z', 'X', 'x']) expect(readLinuxProcessIdentity(123, { ...deps, read: () => stat(state) }).state).toBe('ended');
	});

	test('reads the kernel boot UUID directly', () => {
		let path = '';
		expect(
			readLinuxBootId(value => {
				path = value;
				return `${UUID}\n`;
			})
		).toBe(`linux-boot:${UUID.toLowerCase()}`);
		expect(path).toBe('/proc/sys/kernel/random/boot_id');
	});
});

describe('Windows process handles', () => {
	function api(overrides: Partial<WindowsProcessIdentityApi> = {}): { value: WindowsProcessIdentityApi; closed: bigint[] } {
		const closed: bigint[] = [];
		return {
			value: {
				open: () => ({ handle: 42n, error: 0 }),
				creation: () => 123456789012345678n,
				wait: () => 258,
				close: handle => {
					closed.push(handle);
				},
				...overrides,
			},
			closed,
		};
	}

	test('keeps the complete FILETIME and closes the handle once', () => {
		const process = api();
		expect(readWindowsProcessIdentity(123, process.value)).toEqual({ state: 'running', started: 'win32-filetime:123456789012345678' });
		expect(process.closed).toEqual([42n]);
	});

	test('distinguishes a nonexistent PID from denied or failed OpenProcess', () => {
		for (const error of [87, 5, 6, 8, 0]) {
			const process = api({ open: () => ({ handle: 0n, error }) });
			expect(readWindowsProcessIdentity(123, process.value).state).toBe(error === 87 ? 'ended' : 'unknown');
			expect(process.closed).toEqual([]);
		}
	});

	test('requires a signaled process handle to report termination', () => {
		for (const wait of [0, 0xffffffff, 128]) {
			const process = api({ wait: () => wait });
			expect(readWindowsProcessIdentity(123, process.value).state).toBe(wait === 0 ? 'ended' : 'unknown');
			expect(process.closed).toEqual([42n]);
		}
	});

	test('keeps failed creation-time reads unknown', () => {
		for (const creation of [null, 0n]) {
			const process = api({ creation: () => creation });
			expect(readWindowsProcessIdentity(123, process.value).state).toBe('unknown');
			expect(process.closed).toEqual([42n]);
		}
	});
});

describe('macOS kernel unique IDs', () => {
	test('reads only the verified unique-ID field, not executable UUID or pidversion', () => {
		const data = new Uint8Array(56);
		const view = new DataView(data.buffer);
		view.setBigUint64(16, 123456789012345678n, true);
		const query = () => ({ size: 56, error: 0, data });
		expect(readDarwinProcessIdentity(123, query)).toEqual({ state: 'running', started: 'darwin-uniqueid:123456789012345678' });
		data.fill(255, 0, 16);
		view.setUint32(32, 999, true);
		expect(readDarwinProcessIdentity(123, query)).toEqual({ state: 'running', started: 'darwin-uniqueid:123456789012345678' });
	});

	test('accepts ESRCH as absence but preserves permission and flavor errors', () => {
		for (const error of [3, 1, 13, 22, 0]) expect(readDarwinProcessIdentity(123, () => ({ size: 0, error, data: new Uint8Array(56) })).state).toBe(error === 3 ? 'ended' : 'unknown');
	});

	test('rejects truncated or empty native identity buffers', () => {
		for (const [size, length] of [
			[55, 56],
			[56, 55],
			[56, 56],
		])
			expect(readDarwinProcessIdentity(123, () => ({ size: size!, error: 0, data: new Uint8Array(length!) })).state).toBe('unknown');
	});
});

describe('host native identity', () => {
	test('remains stable within the same process and boot', () => {
		const first = currentNativeProcessIdentity();
		expect(first.pid).toBe(process.pid);
		expect(currentNativeProcessIdentity()).toEqual(first);
		expect(observeNativeProcess(first)).toEqual({ identity: first, state: 'running' });
		const boot = getNativeBootId();
		expect(boot).not.toBeNull();
		expect(getNativeBootId()).toBe(boot);
	});

	test('observes the end of its own child after a normal exit', async () => {
		const source = new URL('../../src/native/process-identity.ts', import.meta.url).href;
		const child = Bun.spawn([process.execPath, '-e', `import { currentNativeProcessIdentity } from ${JSON.stringify(source)}; console.log(JSON.stringify(currentNativeProcessIdentity())); await Bun.stdin.text();`], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
		try {
			const reader = child.stdout.getReader();
			const first = await reader.read();
			const identity = JSON.parse(new TextDecoder().decode(first.value)) as { pid: number; started: string };
			expect(observeNativeProcess(identity).state).toBe('running');
			child.stdin.end();
			expect(await child.exited).toBe(0);
			expect(observeNativeProcess(identity).state).toBe('ended');
			reader.releaseLock();
		} finally {
			child.stdin.end();
			await child.exited;
		}
	});
});
