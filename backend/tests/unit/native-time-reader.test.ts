import { describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readHostTzifOffset, readNativeLinuxTimeStatus, readNativeTimedatedEnvironment } from '../../src/native/linux/time-reader.ts';
import { readTimesyncdConfiguration, type SystemdConfigFilesystem } from '../../src/native/linux/systemd-files.ts';
import { parseTimesyncConfig } from '../../src/system-time-linux.ts';
import { UNREADABLE_STATUS } from '../../src/system-time-common.ts';
import { nativeTimeFixture } from './fixtures/native-time-reader.ts';
import offsets from './fixtures/native-tzif/offsets.json';

function configurationFiles(entries: Record<string, string>, aliases: Record<string, string> = {}) {
	const files = new Map(Object.entries(entries));
	const missing = (): never => {
		throw Object.assign(new Error('Missing fixture file'), { code: 'ENOENT' });
	};
	const fs: SystemdConfigFilesystem = {
		list: async directory => [...new Set([...files.keys(), ...Object.keys(aliases)].filter(path => path.startsWith(`${directory}/`)).map(path => path.slice(directory.length + 1).split('/')[0]!))],
		read: async path => files.get(path) ?? missing(),
		resolve: async path => aliases[path] ?? (files.has(path) ? path : missing()),
		inspect: async path => {
			if (!files.has(path) && !aliases[path]) missing();
			return { isFile: () => files.has(path), isSymbolicLink: () => !!aliases[path] };
		},
	};
	return fs;
}

describe('native systemd configuration files', () => {
	test('selects the highest priority main file and per-name drop-ins before sorting', async () => {
		const fs = configurationFiles(
			{
				'/usr/lib/systemd/timesyncd.conf': '[Time]\nNTP=vendor.example.org\n',
				'/etc/systemd/timesyncd.conf': '[Time]\nNTP=admin.example.org\n',
				'/usr/lib/systemd/timesyncd.conf.d/60-same.conf': '[Time]\nNTP=lower.example.org\n',
				'/usr/local/lib/systemd/timesyncd.conf.d/60-same.conf': '[Time]\nNTP=local.example.org\n',
				'/run/systemd/timesyncd.conf.d/60-same.conf': '[Time]\nNTP=\nNTP=runtime.example.org\n',
				'/etc/systemd/timesyncd.conf.d/90-last.conf': '[Time]\nNTP=\nNTP=final.example.org\n',
				'/usr/lib/systemd/timesyncd.conf.d/95-mask.conf': '[Time]\nNTP=masked.example.org\n',
			},
			{ '/etc/systemd/timesyncd.conf.d/95-mask.conf': '/dev/null' }
		);
		const output = await readTimesyncdConfiguration(undefined, fs);
		expect(parseTimesyncConfig(output)).toBe('final.example.org');
		expect(output).toContain('runtime.example.org');
		for (const hidden of ['vendor.example.org', 'lower.example.org', 'local.example.org', 'masked.example.org']) expect(output).not.toContain(hidden);
		expect(output.indexOf('60-same.conf')).toBeLessThan(output.indexOf('90-last.conf'));
	});
	test('a masked main file hides lower mains but still permits drop-ins', async () => {
		const fs = configurationFiles({ '/usr/lib/systemd/timesyncd.conf': '[Time]\nNTP=hidden.example.org\n', '/run/systemd/timesyncd.conf.d/50-extra.conf': '[Time]\nNTP=chosen.example.org\n' }, { '/etc/systemd/timesyncd.conf': '/dev/null' });
		const output = await readTimesyncdConfiguration(undefined, fs);
		expect(output).not.toContain('hidden.example.org');
		expect(parseTimesyncConfig(output)).toBe('chosen.example.org');
	});
	test('keeps continuation bytes and source boundaries intact', async () => {
		const content = '[Time]\nNTP=first.example.org \\\n# comment\nsecond.example.org\n';
		const fs = configurationFiles({ '/etc/systemd/timesyncd.conf': content, '/etc/systemd/timesyncd.conf.d/90-no-section.conf': 'NTP=invalid.example.org\n' });
		const output = await readTimesyncdConfiguration(undefined, fs);
		expect(output).toContain(content);
		expect(parseTimesyncConfig(output)).toBeNull();
	});
	test('does not accept a partial view when a directory or selected file is unreadable', async () => {
		const fs = configurationFiles({ '/usr/lib/systemd/timesyncd.conf': '[Time]\nNTP=vendor.example.org\n' });
		await expect(
			readTimesyncdConfiguration(undefined, {
				...fs,
				list: async () => {
					throw Object.assign(new Error('denied'), { code: 'EACCES' });
				},
			})
		).rejects.toThrow('denied');
		await expect(
			readTimesyncdConfiguration(undefined, {
				...fs,
				read: async () => {
					throw new Error('file disappeared');
				},
			})
		).rejects.toThrow('file disappeared');
	});
	test('a broken higher-priority link does not expose the lower file', async () => {
		const fs = configurationFiles({ '/usr/lib/systemd/timesyncd.conf': '[Time]\nNTP=vendor.example.org\n' }, { '/etc/systemd/timesyncd.conf': '/missing/config' });
		await expect(readTimesyncdConfiguration(undefined, fs)).rejects.toThrow('Missing fixture file');
	});
	test('returns an empty configuration when none exists', async () => {
		expect(await readTimesyncdConfiguration(undefined, configurationFiles({}))).toBe('');
	});
});

describe('typed time reads', () => {
	test('merges only passed manager values, then unit values, then exact unset entries', async () => {
		const fixture = nativeTimeFixture({ config: null, managerEnvironment: ['SYSTEMD_TIMEDATED_NTP_SERVICES=manager.service', 'NOT_PASSED=hidden'], environment: ['SYSTEMD_TIMEDATED_NTP_SERVICES=unit.service', 'GREETING=literal "quotes" \\ spaces'], passEnvironment: ['SYSTEMD_TIMEDATED_NTP_SERVICES'], unsetEnvironment: ['SYSTEMD_TIMEDATED_NTP_SERVICES=other.service'] });
		expect(await readNativeTimedatedEnvironment({ timeoutMs: 5000 }, fixture.deps)).toEqual({ SYSTEMD_TIMEDATED_NTP_SERVICES: 'unit.service', GREETING: 'literal "quotes" \\ spaces' });
		expect(fixture.closed()).toBe(true);
		const unset = nativeTimeFixture({ config: null, environment: ['SYSTEMD_TIMEDATED_NTP_SERVICES=unit.service'], unsetEnvironment: ['SYSTEMD_TIMEDATED_NTP_SERVICES'] });
		expect(await readNativeTimedatedEnvironment({ timeoutMs: 5000 }, unset.deps)).toEqual({});
	});
	test('EnvironmentFiles keeps the provider ordering unknown even for optional files', async () => {
		const fixture = nativeTimeFixture({ config: null, environmentFiles: [['/etc/example.env', true]] });
		expect(await readNativeTimedatedEnvironment({ timeoutMs: 5000 }, fixture.deps)).toBeNull();
		expect((await readNativeLinuxTimeStatus({ timeoutMs: 5000 }, fixture.deps)).capabilities.setNtpServer).toBe(false);
	});
	test('a missing provider is inactive and does not hide the next loaded provider', async () => {
		const fixture = nativeTimeFixture({ config: '[Time]\nNTP=chosen.example.org\n', ordered: ['chronyd.service', 'systemd-timesyncd.service'], missingUnit: 'chronyd.service' });
		const status = await readNativeLinuxTimeStatus({ timeoutMs: 5000 }, fixture.deps);
		expect(status.capabilities.setNtpServer).toBe(true);
		expect(status.ntpServer).toBe('chosen.example.org');
	});
	test('a provider alias for timesyncd is not a competing daemon', async () => {
		const fixture = nativeTimeFixture({ config: '[Time]\nNTP=chosen.example.org\n', ordered: ['vendor-clock.service'], alias: { name: 'vendor-clock.service', id: 'systemd-timesyncd.service' } });
		const status = await readNativeLinuxTimeStatus({ timeoutMs: 5000 }, fixture.deps);
		expect(status.capabilities.setNtpServer).toBe(true);
		expect(status.clockHeldByUnmanagedDaemon).toBeUndefined();
	});
	test.each(['activating', 'deactivating', 'maintenance', 'future-state'])('a competing service in %s still holds the clock', async activeState => {
		const fixture = nativeTimeFixture({ config: null, canNtp: false, competing: true, activeState });
		const status = await readNativeLinuxTimeStatus({ timeoutMs: 5000 }, fixture.deps);
		expect(status.clockHeldByUnmanagedDaemon).toBe(true);
		expect(status.capabilities.setNtpServer).toBe(false);
	});
	test('a missing timedated service is unsupported and releases its connection', async () => {
		const fixture = nativeTimeFixture({ config: null, missingTimedated: true });
		expect(await readNativeLinuxTimeStatus({ timeoutMs: 5000 }, fixture.deps)).toEqual(UNREADABLE_STATUS);
		expect(fixture.closed()).toBe(true);
	});
	test('expired reads submit no D-Bus request', async () => {
		const fixture = nativeTimeFixture({ config: null });
		let reads = 0;
		const deps = { ...fixture.deps, now: () => (reads++ === 0 ? 0 : 6000) };
		expect(await readNativeLinuxTimeStatus({ timeoutMs: 5000 }, deps)).toEqual(UNREADABLE_STATUS);
		expect(fixture.reads).toHaveLength(0);
	});
	test('offset reads the supplied TZif bytes despite a process TZ override', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'native-time-zone-'));
		const path = join(directory, 'localtime');
		const zone = offsets.zones['Europe/Prague'];
		const original = process.env['TZ'];
		try {
			await writeFile(path, Buffer.from(zone.bytes, 'base64'));
			process.env['TZ'] = 'Pacific/Honolulu';
			const index = 15;
			const expected = zone.offsets[index]!;
			const minutes = (expected[0] === '-' ? -1 : 1) * (Number(expected.slice(1, 3)) * 60 + Number(expected.slice(3)));
			expect(await readHostTzifOffset(path, offsets.instants[index]! * 1000)).toBe(minutes);
			await writeFile(path, 'not a TZif file');
			expect(await readHostTzifOffset(path)).toBeNull();
		} finally {
			if (original === undefined) delete process.env['TZ'];
			else process.env['TZ'] = original;
			await rm(directory, { recursive: true, force: true });
		}
	});
});
