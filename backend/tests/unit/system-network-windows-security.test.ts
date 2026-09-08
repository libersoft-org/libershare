import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';
import type { NetworkFields } from '../helpers/windows-wifi.ts';
import { windowsWifiProfileXml } from '../../src/system-network-windows-profiles.ts';

interface Scenario {
	selected: string;
	first: readonly NetworkFields[];
	second: readonly NetworkFields[];
	alreadyAssociated?: boolean;
	expectedSsidHex?: unknown;
	viaRpc?: boolean;
	associationSsidOctets?: number[];
	associationAuth?: number;
	associationCipher?: number;
	associationSecured?: boolean;
	storedProfile?: string;
}

interface Result {
	lists: number;
	writes: number;
	connections: number;
	ssidHex: string | null;
	authentication: string | null;
	encryption: string | null;
	code?: string;
	detail?: string;
	profiles?: Record<string, string>;
	connectionProfiles?: string[];
}

/** Exercise both real Windows scan/join functions with isolated WLAN buffers and profile calls. */
function attempt(scenario: Scenario): Result {
	const script = `
		import { mock } from 'bun:test';
		import { ptr, toArrayBuffer } from 'bun:ffi';
		import { promisify } from 'node:util';
		import { buildList } from './tests/helpers/windows-wifi.ts';
		const input = ${JSON.stringify(scenario)};
		const native = await import('./src/system-network-windows-wlan.ts');
		const childProcess = await import('node:child_process');
		const environment = await import('./src/network-helper-windows.ts');
		const guid = '{11111111-2222-3333-4444-555555555555}';
		const ssid = input.first[0].ssid;
		const lists = [buildList(input.first), buildList(input.second)];
		let listReads = 0, writes = 0, connections = 0;
		let savedXml = null;
		let disconnected = false;
		const profiles = new Map(input.storedProfile ? [['Saved connection', input.storedProfile]] : []);
		const connectionProfiles = [];
		const retained = [];
		const api = {
			WlanScan: () => 0,
			WlanGetAvailableNetworkList: (_handle, _guid, _flags, _reserved, output) => {
				if (listReads >= lists.length) throw new Error('Unexpected third available-network read');
				new BigUint64Array(toArrayBuffer(output, 0, 8))[0] = BigInt(lists[listReads++]);
				return 0;
			},
			WlanGetProfile: (_handle, _guid, _name, _reserved, output, flags) => {
				const stored = profiles.get(native.readUtf16z(_name));
				if (stored === undefined) return 1168;
				const xml = native.utf16z(stored);
				retained.push(xml);
				new BigUint64Array(toArrayBuffer(output, 0, 8))[0] = BigInt(ptr(xml));
				new Uint32Array(toArrayBuffer(flags, 0, 4))[0] = 2;
				return 0;
			},
			WlanSetProfile: (_handle, _guid, _flags, xml, _security, overwrite) => {
				const document = native.readUtf16z(xml);
				const name = document.match(/<name>(.*?)<\\/name>/)[1];
				if (!overwrite && profiles.has(name)) return 183;
				writes++;
				savedXml = document;
				profiles.set(name, document);
				return 0;
			},
			WlanGetProfileCustomUserData: () => 2,
			WlanDeleteProfile: (_handle, _guid, name) => { profiles.delete(native.readUtf16z(name)); savedXml = null; return 0; },
			WlanConnect: (_handle, _guid, parameters) => {
				connections++;
				connectionProfiles.push(native.readUtf16z(Number(new DataView(toArrayBuffer(parameters, 0, 16)).getBigUint64(8, true))));
				return 0;
			},
			WlanDisconnect: () => { disconnected = true; return 0; },
			WlanReasonCodeToString: () => 87,
			WlanFreeMemory: () => {},
		};
		const associationSnapshot = () => {
				const octets = connections > 0 && input.associationSsidOctets ? input.associationSsidOctets : input.first[0].ssidOctets ?? new TextEncoder().encode(ssid);
				const bytes = new Uint8Array(604);
				const view = new DataView(bytes.buffer);
				view.setUint32(0, !disconnected && (connections > 0 || input.alreadyAssociated) ? 1 : 4, true);
				view.setUint32(520, octets.length, true);
				bytes.set(octets, 524);
				view.setUint32(576, 70, true);
				view.setUint32(588, (input.associationSecured ?? input.first[0].secured) === false ? 0 : 1, true);
				view.setUint32(596, input.associationAuth ?? input.first[0].auth ?? 7, true);
				view.setUint32(600, input.associationCipher ?? input.first[0].cipher ?? 4, true);
				return native.readConnectionAttributes(ptr(bytes), bytes.length);
		};
		mock.module('./src/system-network-windows-wlan.ts', () => ({
			...native,
			withWlanHandle: callback => callback(api, 1n),
			readWindowsWifi: () => new Map([[guid, { radio: 'on', ssid: connections ? ssid : null, signal: 80 }]]),
			readAssociation: associationSnapshot,
			isWindowsWifiDisconnected: () => disconnected,
			readWindowsWifiOperationState: () => ({ state: disconnected ? 4 : 1, profileName: disconnected ? null : connectionProfiles.at(-1), ssidHex: disconnected ? null : associationSnapshot().ssidHex }),
		}));
		const report = { adapters: [{ ifIndex: 1, Name: 'Wi-Fi', InterfaceGuid: guid, Media: 9, IfType: 71, State: 2 }], addresses: [], persistentAddresses: [], interfaces: [{ ifIndex: 1, Family: 2, Dhcp: 1 }], routes: [], persistentRoutes: [], routes6: [], dns: [] };
		const execFile = () => { throw new Error('Only the promised state reader is allowed'); };
		execFile[promisify.custom] = async (_file, args) => {
			if (!args.at(-1).includes('Get-NetAdapter')) throw new Error('Unexpected system command');
			return { stdout: JSON.stringify(report), stderr: '' };
		};
		mock.module('node:child_process', () => ({ ...childProcess, execFile }));
		mock.module('./src/network-helper-windows.ts', () => ({ ...environment, windowsPowerShellPath: () => 'state-reader', windowsSystemEnvironment: () => ({}) }));
		Object.defineProperty(process, 'platform', { value: 'win32' });
		const timer = globalThis.setTimeout;
		globalThis.setTimeout = (callback, delay, ...args) => timer(callback, delay === 4000 ? 0 : delay, ...args);
		if (input.associationSsidOctets || input.associationAuth !== undefined || input.associationCipher !== undefined || input.associationSecured !== undefined) {
			const now = Date.now;
			let polls = 0;
			Date.now = () => now() + (connections ? ++polls * 10001 : 0);
			globalThis.setTimeout = (callback, delay, ...args) => timer(callback, delay === 4000 || delay === 500 ? 0 : delay, ...args);
		}
		const { connectWifi, readCachedCapabilities } = await import('./src/system-network.ts');
		await readCachedCapabilities(async () => ({ ipv4: true, wifi: true, staticGatewayRequired: false }));
		let rpc;
		if (input.viaRpc) {
			const volume = await import('./src/system-volume.ts');
			mock.module('./src/system-volume.ts', () => ({ ...volume, getSystemVolumeStatus: async () => null }));
			const { initSystemHandlers } = await import('./src/api/system.ts');
			rpc = initSystemHandlers({ get: () => '' }, () => {}, () => false, true);
		}
		let failure;
		try {
			const password = input.selected ? 'example-password' : '';
			if (rpc) await rpc.wifiConnect({ interfaceID: guid, ssid, password, expectedSecurity: input.selected, expectedSsidHex: input.expectedSsidHex });
			else await connectWifi(guid, ssid, password, '', null, input.selected, input.expectedSsidHex);
		}
		catch (error) { failure = { code: error.code, detail: error.detail }; }
		if (input.storedProfile) Object.assign(failure ??= {}, { profiles: Object.fromEntries(profiles), connectionProfiles });
		process.stdout.write('RESULT:' + JSON.stringify({ lists: listReads, writes, connections, ssidHex: savedXml?.match(/<hex>(.*?)<\\/hex>/)?.[1] ?? null, authentication: savedXml?.match(/<authentication>(.*?)<\\/authentication>/)?.[1] ?? null, encryption: savedXml?.match(/<encryption>(.*?)<\\/encryption>/)?.[1] ?? null, ...failure }) + '\\n');
	`;
	const result = Bun.spawnSync([process.execPath, '--eval', script], { cwd: resolve(import.meta.dir, '../..'), timeout: 10_000 });
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	expect(result.stderr.toString()).toBe('');
	const output = result.stdout.toString().split(/\r?\n/).find(line => line.startsWith('RESULT:'));
	expect(output).toBeDefined();
	return JSON.parse(output!.slice('RESULT:'.length));
}

const wpa2: NetworkFields = { ssid: 'Example', signal: 70, auth: 7, cipher: 4 };
const wpa3: NetworkFields = { ...wpa2, auth: 9 };
const open: NetworkFields = { ...wpa2, auth: 1, cipher: 0, secured: false };

describe('Windows profile selection across duplicate scan records', () => {
	const storedProfile = windowsWifiProfileXml('Saved connection', new TextEncoder().encode('Example'), 'previous-password')
		.replace('<connectionMode>manual</connectionMode>', '<connectionMode>auto</connectionMode>');
	const named = { ...wpa2, profileName: 'Saved connection' };
	const unnamed = { ...wpa2, profileName: '' };

	it.each([
		{ label: 'unnamed first at equal signal', second: [unnamed, named] },
		{ label: 'named first at equal signal', second: [named, unnamed] },
		{ label: 'stronger unnamed first', second: [{ ...unnamed, signal: 95 }, named] },
		{ label: 'stronger unnamed last', second: [named, { ...unnamed, signal: 95 }] },
		{ label: 'stronger named first', second: [{ ...named, signal: 95 }, unnamed] },
		{ label: 'stronger named last', second: [unnamed, { ...named, signal: 95 }] },
	])('updates the existing profile with $label', ({ second }) => {
		const result = attempt({ selected: 'WPA2', first: [wpa2], second, storedProfile });
		expect(result.code).toBeUndefined();
		expect(result).toMatchObject({ writes: 1, connections: 1, connectionProfiles: ['Saved connection'] });
		expect(Object.keys(result.profiles!)).toEqual(['Saved connection']);
		expect(result.profiles!['Saved connection']).toBe(storedProfile.replace('previous-password', 'example-password'));
	});

	it.each([
		{ label: 'first', second: [named, { ...named, profileName: 'Other connection', signal: 95 }] },
		{ label: 'last', second: [{ ...named, profileName: 'Other connection', signal: 95 }, named] },
	])('refuses multiple stored profiles with the original $label', ({ second }) => {
		const result = attempt({ selected: 'WPA2', first: [wpa2], second, storedProfile });
		expect(result).toMatchObject({ writes: 0, connections: 0, code: 'NETCONFIG_FAILED', profiles: { 'Saved connection': storedProfile } });
	});

	it.each([false, true])('preserves the stored profile refusal (reversed=%s)', reversed => {
		const second = [{ ...unnamed, signal: 95 }, { ...named, connectable: false }];
		const result = attempt({ selected: 'WPA2', first: [wpa2], second: reversed ? second.reverse() : second, storedProfile });
		expect(result).toMatchObject({ writes: 0, connections: 0, code: 'NETCONFIG_FAILED', profiles: { 'Saved connection': storedProfile } });
	});
});

describe('Windows security between the common scan and native profile write', () => {
	it.each([
		{ label: 'WPA3 to WPA2', selected: 'WPA3', first: [wpa3], second: [wpa2] },
		{ label: 'WPA2 to open', selected: 'WPA2', first: [wpa2], second: [open] },
		{ label: 'missing network', selected: 'WPA3', first: [wpa3], second: [] },
		{ label: 'mixed WPA2/WPA3', selected: 'WPA3', first: [wpa3], second: [wpa2, wpa3] },
		{ label: 'reversed mixed WPA3/WPA2', selected: 'WPA3', first: [wpa3], second: [wpa3, wpa2] },
		{ label: 'unsupported cipher', selected: 'WPA2', first: [wpa2], second: [{ ...wpa2, cipher: 2 }] },
		{ label: 'unsupported WPA3 cipher with unchanged label', selected: 'WPA3', first: [wpa3], second: [{ ...wpa3, cipher: 8 }] },
		{ label: 'newly active row', selected: 'WPA2', first: [wpa2], second: [{ ...wpa2, active: true }] },
		{ label: 'weaker active duplicate', selected: 'WPA2', first: [wpa2], second: [wpa2, { ...wpa2, signal: 20, active: true }] },
		{ label: 'reversed weaker active duplicate', selected: 'WPA2', first: [wpa2], second: [{ ...wpa2, signal: 20, active: true }, wpa2] },
		{ label: 'current association', selected: 'WPA2', first: [wpa2], second: [wpa2], alreadyAssociated: true },
		{ label: 'OS refusal', selected: 'WPA2', first: [wpa2], second: [{ ...wpa2, connectable: false }] },
	])('refuses $label without writing or connecting', scenario => {
		const result = attempt(scenario);
		expect(result).toMatchObject({ lists: 2, writes: 0, connections: 0, code: 'NETCONFIG_FAILED' });
	});

	it.each([
		{ label: 'WPA2', selected: 'WPA2', first: [wpa2], second: [{ ...wpa2, signal: 55 }], authentication: 'WPA2PSK', encryption: 'AES' },
		{ label: 'WPA3', selected: 'WPA3', first: [wpa3], second: [{ ...wpa3, signal: 55 }], authentication: 'WPA3SAE', encryption: 'AES' },
		{ label: 'open', selected: '', first: [open], second: [{ ...open, signal: 55 }], authentication: 'open', encryption: 'none' },
		{ label: 'WPA3 with a weaker unsupported access point', selected: 'WPA3', first: [wpa3], second: [wpa3, { ...wpa3, cipher: 8, signal: 20 }], authentication: 'WPA3SAE', encryption: 'AES' },
	])('writes $label with the verified authentication and cipher', scenario => {
		const result = attempt(scenario);
		expect(result).toEqual({ lists: 2, writes: 1, connections: 1, ssidHex: '4578616D706C65', authentication: scenario.authentication, encryption: scenario.encryption });
	});
});

describe('Windows raw SSID identity between selection and profile write', () => {
	const original: NetworkFields = { ...wpa2, ssid: '\uFFFD', ssidOctets: [0xff] };
	const replacement: NetworkFields = { ...original, ssidOctets: [0xfe] };

	it('refuses changed octets with the same display name and security before writing', () => {
		const result = attempt({ selected: 'WPA2', expectedSsidHex: 'FF', first: [original], second: [replacement] });
		expect(result).toMatchObject({ lists: 2, writes: 0, connections: 0, ssidHex: null, code: 'NETCONFIG_FAILED' });
	});

	it('refuses octets that changed before the common scan', () => {
		const result = attempt({ selected: 'WPA2', expectedSsidHex: 'FF', first: [replacement], second: [replacement] });
		expect(result).toMatchObject({ lists: 1, writes: 0, connections: 0, ssidHex: null, code: 'NETCONFIG_INVALID' });
	});

	it('writes the original octets when the identity remains unchanged', () => {
		const result = attempt({ selected: 'WPA2', expectedSsidHex: 'FF', first: [original], second: [{ ...original, signal: 40 }] });
		expect(result).toEqual({ lists: 2, writes: 1, connections: 1, ssidHex: 'FF', authentication: 'WPA2PSK', encryption: 'AES' });
	});
});

describe('Windows raw SSID identity through wifiConnect RPC', () => {
	const network: NetworkFields = { ...wpa2, ssid: '\uFFFD', ssidOctets: [0xff] };

	it('passes the selected identity to the common scan guard', () => {
		const result = attempt({ viaRpc: true, selected: 'WPA2', expectedSsidHex: 'FE', first: [network], second: [network] });
		expect(result).toMatchObject({ lists: 1, writes: 0, connections: 0, code: 'NETCONFIG_INVALID' });
	});

	it.each([
		{ label: 'object', value: {} },
		{ label: 'null', value: null },
		{ label: 'odd length', value: 'F' },
		{ label: 'non-hexadecimal', value: 'GG' },
		{ label: 'over 32 octets', value: 'FF'.repeat(33) },
	])('refuses $label before scanning', ({ value }) => {
		const result = attempt({ viaRpc: true, selected: 'WPA2', expectedSsidHex: value, first: [network], second: [network] });
		expect(result).toMatchObject({ lists: 0, writes: 0, connections: 0, code: 'NETCONFIG_INVALID' });
	});

	it('accepts a lowercase identity without changing its bytes', () => {
		const result = attempt({ viaRpc: true, selected: 'WPA2', expectedSsidHex: 'ff', first: [network], second: [network] });
		expect(result).toEqual({ lists: 2, writes: 1, connections: 1, ssidHex: 'FF', authentication: 'WPA2PSK', encryption: 'AES' });
	});
});

describe('Windows association verifies the raw SSID returned by the native decoder', () => {
	const network: NetworkFields = { ...wpa2, ssid: '\uFFFD', ssidOctets: [0xff] };

	it('does not report another raw SSID as success or roll back while termination is unknown', () => {
		const result = attempt({ selected: 'WPA2', expectedSsidHex: 'FF', first: [network], second: [network], associationSsidOctets: [0xfe] });
		expect(result).toMatchObject({ lists: 2, writes: 1, connections: 1, ssidHex: 'FF', code: 'NETCONFIG_FAILED' });
		expect(result.detail).toContain('unknown result');
	});

	it('reports success when the decoder returns the requested raw SSID', () => {
		const result = attempt({ selected: 'WPA2', expectedSsidHex: 'FF', first: [network], second: [network], associationSsidOctets: [0xff] });
		expect(result).toEqual({ lists: 2, writes: 1, connections: 1, ssidHex: 'FF', authentication: 'WPA2PSK', encryption: 'AES' });
	});
});

describe('Windows association verifies the security returned by the native decoder', () => {
	it.each([
		{ label: 'WPA2 after selecting WPA3', associationAuth: 7 },
		{ label: 'a different cipher', associationCipher: 8 },
		{ label: 'security disabled', associationSecured: false },
	])('does not report success for $label', fields => {
		const result = attempt({ selected: 'WPA3', first: [wpa3], second: [wpa3], ...fields });
		expect(result).toMatchObject({ lists: 2, writes: 1, connections: 1, ssidHex: null, code: 'NETCONFIG_FAILED' });
		expect(result.detail).toContain('the adapter did not join the network');
	});
});
