import { readFile } from 'node:fs/promises';
import { applyTimesyncdDropIn } from '../../src/system-time.ts';
import { verifyTimesyncdServer } from '../../src/system-time-linux.ts';
import type { TimesyncdOperations } from '../../src/native/linux/time-mutation-dropin.ts';
import type { FixtureRunner } from './system-time-fixtures.ts';
import { unreadableByServiceAccount } from '../../src/system-time-files.ts';

/** Temporary fixture paths use mode checks; the native child only accepts the host drop-in. */
export function applyTimesyncdFixture(...args: Parameters<typeof applyTimesyncdDropIn>): ReturnType<typeof applyTimesyncdDropIn> {
	return applyTimesyncdDropIn(args[0], args[1], args[2], args[3], args[4], path => unreadableByServiceAccount(path, async () => null));
}

export async function timesyncConfigOutput(path: string, laterConfiguration = ''): Promise<string> {
	return '# /etc/systemd/timesyncd.conf.d/90-libershare.conf\n' + (await readFile(path, 'utf8')) + laterConfiguration;
}

/** Verification reads the actual temporary file; the delegate handles daemon operations. */
export function withTimesyncConfigRead(path: string, delegate: FixtureRunner): TimesyncdOperations {
	return { verify: server => verifyTimesyncdServer(server, () => timesyncConfigOutput(path)), restart: timeoutMs => delegate({ kind: 'restart' }, timeoutMs) };
}

export function configurationOperations(
	read: () => Promise<string>,
	restart: TimesyncdOperations['restart'] = async () => {
		throw new Error('Unexpected restart');
	}
): TimesyncdOperations {
	return { verify: server => verifyTimesyncdServer(server, read), restart };
}
