import { readFile } from 'node:fs/promises';
import { applyTimesyncdDropIn, type CommandRunner } from '../../src/system-time.ts';
import { unreadableByServiceAccount } from '../../src/system-time-files.ts';

/** Temporary fixture paths use mode checks; the native child only accepts the host drop-in. */
export function applyTimesyncdFixture(...args: Parameters<typeof applyTimesyncdDropIn>): ReturnType<typeof applyTimesyncdDropIn> {
	return applyTimesyncdDropIn(args[0], args[1], args[2], args[3], args[4], path => unreadableByServiceAccount(path, async () => null));
}

export async function timesyncConfigOutput(path: string, laterConfiguration = ''): Promise<string> {
	return '# /etc/systemd/timesyncd.conf.d/90-libershare.conf\n' + (await readFile(path, 'utf8')) + laterConfiguration;
}

/** Verification reads the actual temporary file; the delegate handles daemon operations. */
export function withTimesyncConfigRead(path: string, delegate: CommandRunner): CommandRunner {
	return async (command, args) => {
		if (command !== 'systemd-analyze') return delegate(command, args);
		if (args.join('\0') !== ['--no-pager', 'cat-config', 'systemd/timesyncd.conf'].join('\0')) throw new Error('Unexpected timesyncd configuration command');
		return { kind: 'ok', output: await timesyncConfigOutput(path) };
	};
}
