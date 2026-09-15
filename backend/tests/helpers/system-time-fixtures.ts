import { type CommandRunner, type RunOutcome } from '../../src/system-time.ts';

/** `w32tm /query /status` on a host with a localized date format: only the timestamp is translated. */
export const W32TM_STATUS = 'Leap Indicator: 0(no warning)\r\nStratum: 5 (secondary reference - syncd by (S)NTP)\r\nPrecision: -23 (119.209ns per tick)\r\nRoot Delay: 0.0161789s\r\nRoot Dispersion: 7.7770884s\r\nReferenceId: 0xC0000210 (source IP:  192.0.2.16)\r\nLast Successful Sync Time: 14.08.2026 20:55:55\r\nSource: ntp1.example.org,0x9 \r\nPoll Interval: 15 (32768s)\r\n';

/** Answer a fixed queue of outcomes and record what was asked for. */
export function fakeRunner(outcomes: RunOutcome[]): { exec: CommandRunner; calls: string[] } {
	const calls: string[] = [];
	const queue = [...outcomes];
	const exec: CommandRunner = async (cmd, args) => {
		calls.push([cmd, ...args].join(' '));
		return queue.shift() ?? { kind: 'ok', output: '' };
	};
	return { exec, calls };
}
