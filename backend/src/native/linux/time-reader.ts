import { readFile } from 'node:fs/promises';
import { SystemBus, DBusError, type DBusReply, type DBusRequest, type DBusValue, type DBusVariant } from './dbus.ts';
import { parseTzif, tzifOffsetAt } from '../tzif.ts';
import { readTimesyncdConfiguration } from './systemd-files.ts';
import { canonicalUnitName, clockSteeringUnits, competingNtpUnits, mergeTimedatedEnvironment, parseTimesyncConfig, readNtpUnitsList, TIMESYNCD_UNIT, unitIsLoaded, type UnitState } from '../../system-time-linux.ts';
import { UNREADABLE_STATUS, type PlatformStatus } from '../../system-time-common.ts';

const TIMEDATED = 'org.freedesktop.timedate1';
const TIMEDATED_PATH = '/org/freedesktop/timedate1';
const SYSTEMD = 'org.freedesktop.systemd1';
const SYSTEMD_PATH = '/org/freedesktop/systemd1';
const TIMEDATED_UNIT = 'systemd-timedated.service';
type Properties = Record<string, DBusVariant>;
type ReadRequest = Omit<Extract<DBusRequest, { kind: 'read' }>, 'kind' | 'timeoutUsec'>;
interface Unit extends UnitState {
	path: string;
	names: string[];
	active: string;
}

export interface NativeTimeReadOptions {
	timeoutMs: number;
}
export interface NativeTimeReaderDeps {
	readonly openBus: () => Pick<SystemBus, 'call' | 'close'>;
	readonly configuration: () => Promise<string>;
	readonly providers: (environment: Record<string, string> | null) => Promise<string[] | null>;
	readonly offset: () => Promise<number | null>;
	readonly now: () => number;
}

/** Reads the host zone file directly, ignoring the backend process's TZ override. */
export async function readHostTzifOffset(path: string = '/etc/localtime', nowMs: number = Date.now()): Promise<number | null> {
	try {
		return tzifOffsetAt(parseTzif(await readFile(path)), Math.floor(nowMs / 1000)) / 60;
	} catch {
		return null;
	}
}

const nativeDeps: NativeTimeReaderDeps = { openBus: () => new SystemBus(), configuration: readTimesyncdConfiguration, providers: readNtpUnitsList, offset: readHostTzifOffset, now: () => performance.now() };

function property(values: Properties, name: string, signature: string): DBusValue | undefined {
	const entry = values[name];
	return entry?.sig === signature ? entry.value : undefined;
}

function stringProperty(values: Properties, name: string): string {
	const result = property(values, name, 's');
	if (typeof result !== 'string' || !result) throw new Error(`Unreadable systemd ${name}`);
	return result;
}

function strings(value: DBusValue | undefined): string[] {
	if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error('Unreadable systemd string list');
	return value as string[];
}

function booleanProperty(values: Properties, name: string): boolean | null {
	const result = property(values, name, 'b');
	return typeof result === 'boolean' ? result : null;
}

function openReader(options: NativeTimeReadOptions, deps: NativeTimeReaderDeps) {
	if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error('Invalid time read timeout');
	const deadline = deps.now() + options.timeoutMs;
	const bus = deps.openBus();
	const read = async (request: ReadRequest): Promise<DBusReply> => {
		const remaining = deadline - deps.now();
		if (remaining <= 0) throw new Error('Time read timed out');
		const reply = await bus.call({ ...request, kind: 'read', timeoutUsec: BigInt(Math.max(1, Math.floor(remaining * 1000))) });
		if (reply.type === 'error') throw new DBusError(reply);
		return reply;
	};
	const all = async (destination: string, path: string, iface: string): Promise<Properties> => {
		const reply = await read({ destination, path, interface: 'org.freedesktop.DBus.Properties', member: 'GetAll', signature: 's', args: [iface] });
		const values = reply.values[0];
		if (reply.signature !== 'a{sv}' || reply.values.length !== 1 || !values || typeof values !== 'object' || Array.isArray(values) || values instanceof Map || values instanceof Uint8Array) throw new Error('Invalid time property dictionary');
		return values as Properties;
	};
	const get = async (path: string, iface: string, name: string, signature: string): Promise<DBusValue> => {
		const reply = await read({ destination: SYSTEMD, path, interface: 'org.freedesktop.DBus.Properties', member: 'Get', signature: 'ss', args: [iface, name] });
		const value = reply.values[0];
		if (reply.signature !== 'v' || reply.values.length !== 1 || !value || typeof value !== 'object' || !('sig' in value) || value.sig !== signature || !('value' in value)) throw new Error(`Invalid systemd property ${name}`);
		return value.value;
	};
	const units = new Map<string, Promise<Unit>>();
	const unit = (name: string): Promise<Unit> => {
		let result = units.get(name);
		if (!result) {
			result = (async () => {
				let path: DBusValue | undefined;
				try {
					const reply = await read({ destination: SYSTEMD, path: SYSTEMD_PATH, interface: `${SYSTEMD}.Manager`, member: 'LoadUnit', signature: 's', args: [name] });
					path = reply.values[0];
					if (reply.signature !== 'o' || reply.values.length !== 1 || typeof path !== 'string' || !path.startsWith(`${SYSTEMD_PATH}/unit/`)) throw new Error('Invalid systemd unit path');
				} catch (error) {
					if (error instanceof DBusError && error.errorName === `${SYSTEMD}.NoSuchUnit`) return { id: name, names: [name], load: 'not-found', active: 'inactive', path: '' };
					throw error;
				}
				const values = await all(SYSTEMD, path, `${SYSTEMD}.Unit`);
				return { id: stringProperty(values, 'Id'), names: strings(property(values, 'Names', 'as')), load: stringProperty(values, 'LoadState'), active: stringProperty(values, 'ActiveState'), path };
			})();
			units.set(name, result);
		}
		return result;
	};
	const environment = async (): Promise<Record<string, string> | null> => {
		try {
			const timedated = await unit(TIMEDATED_UNIT);
			if (timedated.load !== 'loaded') return null;
			const [manager, own, files, pass, unset] = await Promise.all([get(SYSTEMD_PATH, `${SYSTEMD}.Manager`, 'Environment', 'as'), get(timedated.path, `${SYSTEMD}.Service`, 'Environment', 'as'), get(timedated.path, `${SYSTEMD}.Service`, 'EnvironmentFiles', 'a(sb)'), get(timedated.path, `${SYSTEMD}.Service`, 'PassEnvironment', 'as'), get(timedated.path, `${SYSTEMD}.Service`, 'UnsetEnvironment', 'as')]);
			if (!Array.isArray(files) || files.length) return null;
			return mergeTimedatedEnvironment(strings(manager), strings(own), strings(pass), strings(unset));
		} catch {
			return null;
		}
	};
	return { all, unit, environment, close: () => bus.close() };
}

export async function readNativeTimedatedEnvironment(options: NativeTimeReadOptions, deps: NativeTimeReaderDeps = nativeDeps): Promise<Record<string, string> | null> {
	let reader: ReturnType<typeof openReader> | undefined;
	try {
		reader = openReader(options, deps);
		return await reader.environment();
	} catch {
		return null;
	} finally {
		reader?.close();
	}
}

/** Run inside the read worker; no setter or service activation job is submitted. */
export async function readNativeLinuxTimeStatus(options: NativeTimeReadOptions, deps: NativeTimeReaderDeps = nativeDeps): Promise<PlatformStatus> {
	let reader: ReturnType<typeof openReader>;
	try {
		reader = openReader(options, deps);
	} catch {
		return UNREADABLE_STATUS;
	}
	try {
		const [properties, offset] = await Promise.all([reader.all(TIMEDATED, TIMEDATED_PATH, TIMEDATED).catch(() => null), deps.offset().catch(() => null)]);
		if (!properties) return UNREADABLE_STATUS;
		const canNtp = booleanProperty(properties, 'CanNTP') === true;
		const ntpEnabled = booleanProperty(properties, 'NTP');
		const ordered = canNtp ? await deps.providers(await reader.environment()).catch(() => null) : [];
		let states: Map<string, UnitState> | null = null;
		if (canNtp) {
			try {
				const loaded = await Promise.all((ordered?.length ? ordered : [TIMESYNCD_UNIT]).map(reader.unit));
				states = new Map(loaded.flatMap(unit => [...new Set([unit.id, ...unit.names])].map(name => [name, unit] as const)));
			} catch {
				states = null;
			}
		}
		const steering = clockSteeringUnits(ordered, states);
		let active: Set<string> | null;
		try {
			const units = await Promise.all(steering.map(reader.unit));
			active = new Set(units.filter(unit => !['inactive', 'failed'].includes(unit.active)).flatMap(unit => [unit.id, ...unit.names]));
		} catch {
			active = null;
		}
		const competing = competingNtpUnits(ordered, states).map(name => canonicalUnitName(states, name));
		const first = ordered?.find(name => states !== null && unitIsLoaded(states, name));
		const selected = ordered !== null && states !== null && (ordered.length ? first !== undefined && canonicalUnitName(states, first) === TIMESYNCD_UNIT : unitIsLoaded(states, TIMESYNCD_UNIT));
		const configurable = selected && active !== null && !competing.some(name => active.has(name));
		const heldElsewhere = ntpEnabled === true ? false : active === null ? null : steering.some(name => active.has(canonicalUnitName(states, name)));
		const configuration = configurable ? await deps.configuration().catch(() => null) : null;
		const timezone = property(properties, 'Timezone', 's');
		return {
			timezone: typeof timezone === 'string' ? timezone : null,
			...(offset === null ? {} : { utcOffsetMinutes: offset }),
			ntpEnabled,
			ntpSynchronized: booleanProperty(properties, 'NTPSynchronized'),
			ntpServer: configuration === null ? null : parseTimesyncConfig(configuration),
			...(heldElsewhere === false ? {} : { clockHeldByUnmanagedDaemon: heldElsewhere }),
			capabilities: { setClock: true, setTimezone: true, setNtpEnabled: canNtp, setNtpServer: configurable },
		};
	} finally {
		reader.close();
	}
}
