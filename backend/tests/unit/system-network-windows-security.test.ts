import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';
import type { NetworkFields } from '../helpers/windows-wifi.ts';

interface Scenario {
	selected: string;
	first: readonly NetworkFields[];
	second: readonly NetworkFields[];
	alreadyAssociated?: boolean;
}

interface Result {
	lists: number;
	writes: number;
	connections: number;
	authentication: string | null;
	encryption: string | null;
	code?: string;
	detail?: string;
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
		const retained = [];
		const api = {
			WlanScan: () => 0,
			WlanGetAvailableNetworkList: (_handle, _guid, _flags, _reserved, output) => {
				if (listReads >= lists.length) throw new Error('Unexpected third available-network read');
				new BigUint64Array(toArrayBuffer(output, 0, 8))[0] = BigInt(lists[listReads++]);
				return 0;
			},
			WlanGetProfile: (_handle, _guid, _name, _reserved, output, flags) => {
				if (savedXml === null) return 1168;
				const xml = native.utf16z(savedXml);
				retained.push(xml);
				new BigUint64Array(toArrayBuffer(output, 0, 8))[0] = BigInt(ptr(xml));
				new Uint32Array(toArrayBuffer(flags, 0, 4))[0] = 2;
				return 0;
			},
			WlanSetProfile: (_handle, _guid, _flags, xml) => { writes++; savedXml = native.readUtf16z(xml); return 0; },
			WlanGetProfileCustomUserData: () => 2,
			WlanConnect: () => { connections++; return 0; },
			WlanReasonCodeToString: () => 87,
			WlanFreeMemory: () => {},
		};
		mock.module('./src/system-network-windows-wlan.ts', () => ({
			...native,
			withWlanHandle: callback => callback(api, 1n),
			readWindowsWifi: () => new Map([[guid, { radio: 'on', ssid: connections ? ssid : null, signal: 80 }]]),
			readAssociation: () => ({ connected: connections > 0 || !!input.alreadyAssociated, ssid: connections > 0 || input.alreadyAssociated ? ssid : null }),
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
		const { connectWifi, readCachedCapabilities } = await import('./src/system-network.ts');
		await readCachedCapabilities(async () => ({ ipv4: true, wifi: true, staticGatewayRequired: false }));
		let failure;
		try { await connectWifi(guid, ssid, input.selected ? 'example-password' : '', '', null, input.selected); }
		catch (error) { failure = { code: error.code, detail: error.detail }; }
		process.stdout.write('RESULT:' + JSON.stringify({ lists: listReads, writes, connections, authentication: savedXml?.match(/<authentication>(.*?)<\\/authentication>/)?.[1] ?? null, encryption: savedXml?.match(/<encryption>(.*?)<\\/encryption>/)?.[1] ?? null, ...failure }) + '\\n');
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
		expect(result).toEqual({ lists: 2, writes: 1, connections: 1, authentication: scenario.authentication, encryption: scenario.encryption });
	});
});
