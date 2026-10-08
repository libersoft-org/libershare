import { readFileSync, readlinkSync } from 'node:fs';
import type { PlatformStatus } from './system-time-common.ts';
import { readDarwinTimeStatusAsync } from './native/darwin/time-reader.ts';

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
 * The synchronization flag is read separately through CoreTime, including below root.
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

/**
 * The symlink macOS keeps the active zone in, and the only unprivileged way to read it.
 *
 * Measured on macOS 15.7.4: `/etc/localtime` is `lrwxr-xr-x root:wheel` pointing at
 * `/var/db/timezone/zoneinfo/Europe/Prague`, readable by any user, and it follows
 * `systemsetup -settimezone` immediately.
 *
 * Without it the zone came from `systemsetup`, which refuses an unprivileged read, and the
 * status fell back to the PROCESS zone - so after the privileged helper changed the host,
 * the backend kept reporting the old zone indefinitely, and sent it as `expectedTimezone`
 * on the next save, where the helper refused it as composed against state that has changed.
 */
const MAC_LOCALTIME = '/etc/localtime';

/** The zone identifier inside a zoneinfo path (`/var/db/timezone/zoneinfo/Europe/Prague`). */
export function parseZoneinfoLink(target: string): string | null {
	const match = /\/zoneinfo\/(.+)$/.exec(target.replace(/\\/g, '/'));
	const zone = match?.[1]?.replace(/^\/+|\/+$/g, '');
	return zone ? zone : null;
}

/** Read {@link MAC_LOCALTIME}. Null when it is not a zoneinfo symlink; never throws. */
export function readMacLocaltimeZone(path: string = MAC_LOCALTIME): string | null {
	try {
		return parseZoneinfoLink(readlinkSync(path));
	} catch {
		return null;
	}
}

/** Native reads run outside the main event loop and do not depend on administrator-only tools. */
export function readMacStatus(reader: () => Promise<PlatformStatus> = readDarwinTimeStatusAsync): Promise<PlatformStatus> {
	return reader();
}
