import { variant, type DBusReply, type DBusRequest } from '../../../src/native/linux/dbus.ts';
import type { NativeTimeReaderDeps } from '../../../src/native/linux/time-reader.ts';
import { parseUtcOffsetMinutes } from '../../../src/system-time-common.ts';
import { readNtpUnitsList } from '../../../src/system-time-linux.ts';

export interface TimeStatusScenario {
	config: string | null;
	runtime?: string | null;
	enabled?: boolean;
	owner?: 'ours' | 'foreign' | 'unknown' | 'masked';
	competing?: boolean | 'timesyncd';
	alias?: { name: string; id: string };
	activityFails?: boolean;
	ordered?: string[];
	canNtp?: boolean;
	ntpField?: string;
	offset?: string | null;
	managerEnvironment?: string[];
	environment?: string[];
	passEnvironment?: string[];
	unsetEnvironment?: string[];
	environmentFiles?: [string, boolean][];
	missingTimedated?: boolean;
	missingUnit?: string;
	activeState?: string;
}

export function nativeTimeFixture(input: TimeStatusScenario): { deps: NativeTimeReaderDeps; reads: DBusRequest[]; files: string[]; closed: () => boolean } {
	const reads: DBusRequest[] = [];
	const files: string[] = [];
	let closed = false;
	const unitPaths = new Map<string, string>();
	const timesyncd = 'systemd-timesyncd.service';
	const timedated = 'systemd-timedated.service';
	const owner = input.owner ?? 'ours';
	const SYSTEMD = 'org.freedesktop.systemd1';
	const reply = (signature: string, ...values: DBusReply['values']): DBusReply => ({ type: 'method_return', sender: ':1.42', signature, values, errorName: null, errorMessage: null });
	const deps: NativeTimeReaderDeps = {
		openBus: () => ({
			close: () => {
				closed = true;
			},
			call: async request => {
				reads.push(request);
				if (request.kind !== 'read') throw new Error('Unexpected time mutation');
				if (request.destination === 'org.freedesktop.timedate1') {
					if (input.missingTimedated) throw new Error('timedated unavailable');
					return reply('a{sv}', { Timezone: variant('s', 'Europe/Prague'), CanNTP: variant('b', input.canNtp !== false), NTP: input.ntpField === 'maybe' ? variant('s', 'maybe') : variant('b', input.ntpField ? input.ntpField === 'yes' : (input.enabled ?? false)), NTPSynchronized: variant('b', false) });
				}
				if (request.member === 'LoadUnit') {
					const name = request.args![0] as string;
					if (name === input.missingUnit) return { ...reply(''), type: 'error', errorName: `${SYSTEMD}.NoSuchUnit` };
					const path = `/org/freedesktop/systemd1/unit/${name.replace(/[^A-Za-z0-9]/g, character => '_' + character.charCodeAt(0).toString(16))}`;
					unitPaths.set(path, name);
					return reply('o', path);
				}
				if (request.member === 'GetAll') {
					const name = unitPaths.get(request.path)!;
					if (input.activityFails && name !== timedated) throw new Error('Unit state unavailable');
					const alias = input.alias?.name === name ? input.alias.id : name;
					const active = input.alias?.name === name || (input.competing === true && name !== timesyncd && name !== timedated) || (input.competing === 'timesyncd' && name === timesyncd);
					return reply('a{sv}', { Id: variant('s', alias), Names: variant('as', [...new Set([name, alias])]), LoadState: variant('s', name === timesyncd && owner === 'masked' ? 'masked' : 'loaded'), ActiveState: variant('s', active ? (input.activeState ?? 'active') : 'inactive') });
				}
				if (request.member === 'Get') {
					const [iface, property] = request.args as string[];
					if (iface === `${SYSTEMD}.Manager`) {
						if (owner === 'unknown') throw new Error('Manager environment unavailable');
						return reply('v', variant('as', input.managerEnvironment ?? []));
					}
					const environment = input.environment ?? [`SYSTEMD_TIMEDATED_NTP_SERVICES=${(input.ordered ?? (owner === 'foreign' ? ['chronyd.service', timesyncd] : [timesyncd])).join(':')}`];
					if (property === 'Environment') return reply('v', variant('as', environment));
					if (property === 'EnvironmentFiles') return reply('v', variant('a(sb)', input.environmentFiles ?? []));
					if (property === 'PassEnvironment') return reply('v', variant('as', input.passEnvironment ?? []));
					if (property === 'UnsetEnvironment') return reply('v', variant('as', input.unsetEnvironment ?? []));
				}
				throw new Error(`Unexpected time read ${request.member}`);
			},
		}),
		configuration: async () => {
			files.push('systemd/timesyncd.conf');
			if (input.config === null) throw new Error('Configuration unreadable');
			return input.config;
		},
		providers: environment => readNtpUnitsList(environment, []),
		offset: async () => {
			files.push('/etc/localtime');
			return parseUtcOffsetMinutes(input.offset === undefined ? '+0200' : input.offset);
		},
		now: () => 0,
	};
	return { deps, reads, files, closed: () => closed };
}
