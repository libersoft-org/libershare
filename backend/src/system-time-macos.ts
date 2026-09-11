import { readFileSync } from 'node:fs';
import { type PlatformStatus, type SystemCommand, tryRead } from './system-time-common.ts';

/** `systemsetup` is not on a default non-root PATH on macOS, so it is always addressed absolutely. */
export const MAC_SYSTEMSETUP = '/usr/sbin/systemsetup';

/**
 * `systemsetup` refuses every operation, reads included, when it is not run as root —
 * and still EXITS ZERO. Measured on macOS 15.7.4: each of `-settimezone`,
 * `-setnetworktimeserver`, `-setusingnetworktime` and `-settime` printed
 * "You need administrator access to run this tool... exiting!" on stdout and exited 0,
 * changing nothing. Without matching that text every unprivileged write would be
 * reported as a success, so the message is what decides, not the exit code.
 */
export const MAC_NEEDS_ROOT_RE = /administrator access/i;

/** A `systemsetup` write, failing on the refusal it exits zero for. */
export function macSystemsetup(args: string[]): SystemCommand {
	return { cmd: MAC_SYSTEMSETUP, args, failOnOutput: MAC_NEEDS_ROOT_RE };
}

/**
 * Pull the value out of a `systemsetup -get...` line (`Network Time Server: time.apple.com`).
 * Returns null when the tool printed an error instead of a `label: value` pair.
 */
export function parseSystemsetupValue(output: string): string | null {
	const line = output.trim().split('\n')[0];
	if (!line) return null;
	const colon = line.indexOf(':');
	if (colon < 0) return null;
	const value = line.slice(colon + 1).trim();
	return value ? value : null;
}

/** `systemsetup -getusingnetworktime` prints `Network Time: On|Off`. */
export function parseSystemsetupOnOff(output: string): boolean | null {
	const value = parseSystemsetupValue(output);
	if (value === null) return null;
	if (/^on$/i.test(value)) return true;
	if (/^off$/i.test(value)) return false;
	return null;
}

/**
 * Where macOS keeps the configured time server in a file an ordinary user may read.
 *
 * Measured on macOS 15.7.4: `/etc/ntp.conf` is `-rw-r--r-- root:wheel` and holds
 * `server time.euro.apple.com`, and it tracks what `systemsetup -setnetworktimeserver`
 * writes. That matters because `systemsetup` needs root for its READS as well, so without
 * this an unprivileged backend showed the server field EMPTY - including right after the
 * user had successfully saved one through the privileged helper.
 *
 * The synchronisation flag has no such source: `/var/db/timed` is `drwxr-x--- _timed` and
 * `/Library/Preferences/com.apple.timed.plist` does not exist, so `ntpEnabled` stays
 * unknown below root and the screen says so.
 */
const MAC_NTP_CONF = '/etc/ntp.conf';

/**
 * First `server <address>` line of an `ntp.conf`, or null when there is none.
 *
 * Comments are ignored, and so is everything after the address on the line: `ntp.conf`
 * allows per-server options (`iburst`, `minpoll 4`) that are not part of the name.
 */
export function parseNtpConfServer(contents: string): string | null {
	for (const line of contents.split('\n')) {
		const bare = line.split('#')[0]!.trim();
		const match = /^server\s+(\S+)/i.exec(bare);
		if (match) return match[1]!;
	}
	return null;
}

/** Read {@link MAC_NTP_CONF}. Null when it is not there or cannot be read; never throws. */
export function readMacNtpConfServer(path: string = MAC_NTP_CONF): string | null {
	try {
		return parseNtpConfServer(readFileSync(path, 'utf8'));
	} catch {
		return null;
	}
}

/** Read the macOS (`systemsetup`) part of the status. Every subcommand, reads included, needs root. */
export async function readMacStatus(readNtpConf: () => string | null = readMacNtpConfServer): Promise<PlatformStatus> {
	const zone = await tryRead(MAC_SYSTEMSETUP, ['-gettimezone']);
	const server = await tryRead(MAC_SYSTEMSETUP, ['-getnetworktimeserver']);
	const using = await tryRead(MAC_SYSTEMSETUP, ['-getusingnetworktime']);
	// An unreadable systemsetup is an unprivileged process, not a missing facility:
	// the capabilities stay true so the UI keeps offering the controls and the write
	// reports the permission problem.
	return {
		timezone: zone === null ? null : parseSystemsetupValue(zone),
		ntpEnabled: using === null ? null : parseSystemsetupOnOff(using),
		// macOS exposes no "last sync succeeded" flag.
		ntpSynchronized: null,
		// `systemsetup` first, because it is the authority; the file is the fallback that keeps
		// the field populated for an unprivileged reader (see readMacNtpConfServer).
		ntpServer: (server === null ? null : parseSystemsetupValue(server)) ?? readNtpConf(),
		capabilities: { setClock: true, setTimezone: true, setNtpServer: true, setNtpEnabled: true },
	};
}
