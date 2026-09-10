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

/** Read the macOS (`systemsetup`) part of the status. Every subcommand, reads included, needs root. */
export async function readMacStatus(): Promise<PlatformStatus> {
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
		ntpServer: server === null ? null : parseSystemsetupValue(server),
		capabilities: { setClock: true, setTimezone: true, setNtpServer: true, setNtpEnabled: true },
	};
}
