import { splitNmcliFields } from './system-network-linux-wifi.ts';

/**
 * Batched reads of NetworkManager profile details.
 *
 * One `nmcli connection show uuid A uuid B …` replaces a process per profile: a Docker host
 * with ~150 bridge ports took ~24 s to read one by one — past the screen's read timeout — and
 * ~0.2 s as one batch. The output is only trusted when it is complete: every requested profile
 * appears exactly once with its whole `connection` section, and with either the whole `ipv4`
 * section or none on a profile that genuinely has no IPv4 (a bridge or bond port).
 */

/** Detail fields read for every profile, in the order nmcli prints them. */
export const NMCLI_PROFILE_FIELDS = ['connection.uuid', 'connection.type', 'connection.master', 'connection.slave-type', 'connection.interface-name', 'connection.multi-connect', 'ipv4.method', 'ipv4.never-default', 'ipv4.gateway', 'ipv4.addresses', 'ipv4.routes', 'ipv4.route-table', 'ipv4.routing-rules'] as const;

const CONNECTION_FIELDS = NMCLI_PROFILE_FIELDS.filter(field => field.startsWith('connection.'));
const IPV4_FIELDS = NMCLI_PROFILE_FIELDS.filter(field => field.startsWith('ipv4.'));

/** Profiles per `nmcli` process; keeps the argument list to a few kilobytes. */
export const MAX_PROFILES_PER_READ = 256;

/** Connection types NetworkManager gives no IP configuration at all. */
const TYPES_WITHOUT_IP = new Set(['wpan', '6lowpan']);
/** Port types whose profile carries no IP configuration; the controller owns it. */
const PORT_TYPES_WITHOUT_IP = new Set(['bridge', 'bond', 'team', 'ovs-bridge', 'ovs-port']);

/** A batched read whose output could not be trusted as a complete answer. */
export class IncompleteProfileReadError extends Error {
	constructor(reason: string) {
		super(`incomplete NetworkManager profile read: ${reason}`);
		this.name = 'IncompleteProfileReadError';
	}
}

/** How the batched read runs `nmcli`; production passes the shared runner. */
export interface NmcliProfileReadDeps {
	/** Run `nmcli` with these arguments and return stdout; rejects on failure or abort. */
	readonly run: (args: string[], signal: AbortSignal) => Promise<string>;
	/** Stops the read: no further batch starts once it is aborted. */
	readonly signal: AbortSignal;
}

/** The `nmcli` arguments that read the details of `uuids`. */
export function nmcliProfileArgs(uuids: readonly string[]): string[] {
	return ['-t', '-m', 'multiline', '-e', 'yes', '-f', NMCLI_PROFILE_FIELDS.join(','), 'connection', 'show', ...uuids.flatMap(uuid => ['uuid', uuid])];
}

/**
 * Split batched output into one block of `key:value` lines per profile, keyed by UUID. A block
 * starts at `connection.uuid`; blank lines between blocks are optional (NetworkManager 1.42
 * prints them, 1.46 does not). Throws when a block is not exactly one requested profile with a
 * complete connection section and a complete — or legitimately absent — IPv4 section.
 */
export function parseNmcliProfileBlocks(text: string, requested: readonly string[]): Map<string, string> {
	const wanted = new Set(requested);
	const blocks = new Map<string, { fields: Map<string, string>; lines: string[] }>();
	let current: { fields: Map<string, string>; lines: string[] } | null = null;
	for (const rawLine of text.split('\n')) {
		const line = rawLine.replace(/\r$/, '');
		if (line.trim() === '') continue;
		const fields = splitNmcliFields(line);
		const key = fields[0] ?? '';
		const value = fields.slice(1).join(':');
		if (key === 'connection.uuid') {
			if (!wanted.has(value)) throw new IncompleteProfileReadError(`unexpected profile ${value}`);
			if (blocks.has(value)) throw new IncompleteProfileReadError(`profile ${value} listed twice`);
			current = { fields: new Map(), lines: [] };
			blocks.set(value, current);
		}
		if (!current) throw new IncompleteProfileReadError('output does not start with a profile');
		if (current.fields.has(key)) throw new IncompleteProfileReadError(`field ${key} repeated`);
		current.fields.set(key, value);
		current.lines.push(line);
	}
	const result = new Map<string, string>();
	for (const uuid of wanted) {
		const entry = blocks.get(uuid);
		if (!entry) throw new IncompleteProfileReadError(`profile ${uuid} missing`);
		const block = entry.fields;
		const missing = CONNECTION_FIELDS.find(field => !block.has(field));
		if (missing) throw new IncompleteProfileReadError(`profile ${uuid} lacks ${missing}`);
		if ((block.get('connection.type') ?? '') === '') throw new IncompleteProfileReadError(`profile ${uuid} has no type`);
		const ipv4Present = IPV4_FIELDS.filter(field => block.has(field)).length;
		if (ipv4Present > 0 && ipv4Present < IPV4_FIELDS.length) throw new IncompleteProfileReadError(`profile ${uuid} has a partial IPv4 section`);
		if (ipv4Present === 0 && !hasNoIPv4(block)) throw new IncompleteProfileReadError(`profile ${uuid} has no IPv4 section`);
		result.set(uuid, entry.lines.join('\n'));
	}
	return result;
}

/**
 * True for a profile NetworkManager configures no IPv4 on: a WPAN type, or a port of a
 * bridge/bond/team/OVS controller. An `ovs-interface` and a VRF port carry IP, so they do not
 * qualify; neither does a device name or a missing method on its own.
 */
function hasNoIPv4(block: Map<string, string>): boolean {
	const type = block.get('connection.type') ?? '';
	if (TYPES_WITHOUT_IP.has(type)) return true;
	if (type === 'ovs-interface') return false;
	return (block.get('connection.master') ?? '') !== '' && PORT_TYPES_WITHOUT_IP.has(block.get('connection.slave-type') ?? '');
}

/**
 * Read the details of every profile in `uuids`, at most {@link MAX_PROFILES_PER_READ} per
 * process and one process at a time. Each UUID maps to its block of `key:value` lines. Nothing
 * is read for an empty list; an aborted signal stops before the next batch.
 */
export async function readNmcliProfileBlocks(uuids: readonly string[], deps: NmcliProfileReadDeps): Promise<Map<string, string>> {
	const unique = [...new Set(uuids)];
	const result = new Map<string, string>();
	for (let start = 0; start < unique.length; start += MAX_PROFILES_PER_READ) {
		deps.signal.throwIfAborted();
		const batch = unique.slice(start, start + MAX_PROFILES_PER_READ);
		for (const [uuid, block] of parseNmcliProfileBlocks(await deps.run(nmcliProfileArgs(batch), deps.signal), batch)) result.set(uuid, block);
	}
	return result;
}
