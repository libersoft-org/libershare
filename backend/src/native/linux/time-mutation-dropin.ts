import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { SystemTimeResult } from '../../../../shared/src/index.ts';
import { TIMESYNCD_DROPIN_PATH, buildTimesyncdDropIn, verifyTimesyncdServer } from '../../system-time-linux.ts';
import { runAll, runWrite, result, remainingSaveBudget, SAVE_BUDGET_MS, WRITE_TIMEOUT_MS, withFollowUpBudget, type CommandRunner } from '../../system-time-common.ts';
import { syncDirectory, unreadableByServiceAccount, writeFileAtomically, type RollbackHandle } from '../../system-time-files.ts';
import { requireNativeMutationContext } from '../mutation-context.ts';
import { recordLinuxTimeRecovery } from './time-mutation-state.ts';
import { runLinuxTimeOperation } from './time-mutation.ts';

function budgetedTimeout(): number { return Math.max(1, Math.floor(Math.min(WRITE_TIMEOUT_MS, remainingSaveBudget() ?? WRITE_TIMEOUT_MS))); }

export async function executeTimesyncdDropIn(server: string, syncRunning: boolean, path: string = TIMESYNCD_DROPIN_PATH, exec: CommandRunner = runWrite, syncDir: (dir: string) => Promise<void> = syncDirectory, checkAccess: (path: string) => Promise<string | null> = unreadableByServiceAccount): Promise<SystemTimeResult> {
	const native = process.platform === 'linux' && exec === runWrite;
	const context = native ? requireNativeMutationContext() : undefined;
	let readOriginal: ((path: string) => Promise<string>) | undefined;
	if (context) {
		if (path !== TIMESYNCD_DROPIN_PATH) throw new Error('Native time writes require the fixed timesyncd drop-in');
		let before: string | null;
		try { before = await readFile(path, 'utf8'); }
		catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === 'EACCES' || code === 'EPERM') return result('permission-denied', `cannot read ${path} before writing`);
			if (code !== 'ENOENT') throw error;
			before = null;
		}
		const hash = (content: string): string => createHash('sha256').update(content).digest('hex');
		await recordLinuxTimeRecovery(context, { ntpServer: server, dropin: { beforeHash: before === null ? null : hash(before), targetHash: hash(buildTimesyncdDropIn(server)) } });
		readOriginal = async file => {
			const actual = await readFile(file, 'utf8').catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT' && before !== null) throw new Error('The time configuration changed before writing'); throw error; });
			if (actual !== before) throw new Error('The time configuration changed before writing');
			return actual;
		};
	}
	const fileChange = async <T>(action: () => Promise<T>): Promise<T> => {
		if (!context) return action();
		const outcome = await context.call<{ success: true; value: T } | { success: false; error: unknown }>({ kind: 'executor' }, async () => {
			try { return { known: true, value: { success: true as const, value: await action() } }; }
			catch (error) { return { known: true, value: { success: false as const, error } }; }
		});
		if (!outcome.success) throw outcome.error;
		return outcome.value;
	};

	// Creating a budget does not enforce it - each operation has to ask, and this one is the
	// path that never reached `runAll` at all: with synchronisation off there is no daemon to
	// restart, so the file write and its verification ARE the whole change and used to run
	// however late the save already was. Measured with a budget already at -1 ms: the write
	// went ahead and the verification took a fresh 90 s of its own.
	//
	// Asked BEFORE the write, because afterwards the honest answer is no longer "nothing
	// happened" - and the rollback that repairs a late write is deliberately NOT subject to
	// the budget: refusing to undo a change because time ran out is the one outcome worse
	// than being slow.
	const remaining = remainingSaveBudget();
	if (remaining !== null && remaining <= 0) return result('error', `the time configuration did not start within the ${Math.round(SAVE_BUDGET_MS / 1000)} s this save is allowed`);
	let rollback: RollbackHandle;
	try {
		rollback = await fileChange(() => writeFileAtomically(path, buildTimesyncdDropIn(server), readOriginal, syncDir));
	} catch (err) {
		const e = err as { code?: string; message?: string; published?: boolean };
		// The content reached its final name and only the flush afterwards failed, so this
		// is not "nothing happened": the file is on disk, the daemon was never restarted
		// onto it, and the host adopts it at the next start unless somebody removes it.
		if (e.published) return { ...result('error', `${path} now holds the new server but could not be flushed to disk (${e.message ?? 'the directory flush failed'}), so systemd-timesyncd was not restarted onto it`), changed: true, stateMayHaveChanged: true };
		if (e.code === 'EACCES' || e.code === 'EPERM') return result('permission-denied', `cannot write ${path}`);
		return result('error', e.message ?? `cannot write ${path}`);
	}
	// Reachability before content: `systemd-analyze` reads as US, so a directory the daemon
	// cannot enter passes every check below while the daemon never sees the file.
	const unreachable = process.platform === 'win32' ? null : await checkAccess(path);
	// The remainder, not a fresh limit of its own: this runs after a write that has already
	// spent part of the save's time.
	const verification = unreachable ?? (await verifyTimesyncdServer(server, exec === runWrite ? undefined : (cmd, args, timeoutMs) => exec(cmd, args, timeoutMs ?? budgetedTimeout())));
	if (verification !== null) {
		const restored = await fileChange(rollback);
		if (restored.state === 'not-restored') return { ...result('error', `${verification} (${path} could not be restored safely; its current configuration was left untouched)`), changed: true, stateMayHaveChanged: true };
		if (restored.state === 'restored-not-durable') return { ...result('error', `${verification} (${path} was restored but could not be flushed to disk, so it may not survive a crash)`), stateMayHaveChanged: true };
		return result('error', verification);
	}
	const commands = syncRunning ? [{ cmd: 'systemctl', args: ['restart', 'systemd-timesyncd'] }] : [];
	const restart = () => native ? runLinuxTimeOperation(api => api.restartTimesyncd()) : runAll('linux', commands, exec);
	// Synchronisation is off, so there is deliberately no restart — the drop-in on disk
	// IS the whole change and is read when the daemon next starts. Nothing to roll back,
	// so the spare name the restore was holding is released here rather than left next to
	// the live configuration until some later write sweeps it.
	if (commands.length === 0) {
		await fileChange(rollback.discard);
		return result('ok');
	}
	const r = await restart();
	if (!r.success) {
		const restored = await fileChange(rollback);
		const reason = r.message ?? 'the change could not be applied';
		// A restart would load the current file, which may be our rejected value or a
		// later administrator's edit. Do not activate either after a failed rollback.
		if (restored.state === 'not-restored') return { ...r, changed: true, stateMayHaveChanged: true, message: `${reason} (${path} could not be restored safely; its current configuration and systemd-timesyncd were left as they are)` };
		// Both restored states get the restart: the visible file is the original one either
		// way, and only its durability is in question. Skipping it over a failed flush left
		// the daemon stopped, or running the configuration just withdrawn, while the file
		// on disk was in fact the old one.
		//
		// The daemon has to be put back onto the restored file for the rollback to mean
		// anything, so this restart is part of it and its outcome is part of the answer.
		// Discarded, a rollback that put the file back and left the daemon down reported as
		// a clean undo.
		//
		// Under the RESTORE budget, not the save's. The failure being undone is often the
		// save running out of time, and inheriting an exhausted budget made `runAll` refuse
		// this restart before starting it: the file was back, the daemon was left stopped,
		// and the result said the host had been restored. The lock still covers this, so the
		// next save waits for it.
		const back = await withFollowUpBudget(restart);
		const caveats: string[] = [];
		if (!back.success) caveats.push('systemd-timesyncd could not be restarted onto it');
		if (restored.state === 'restored-not-durable') caveats.push('the restore could not be flushed to disk, so it may not survive a crash or a power loss');
		if (caveats.length > 0) return { ...r, message: `${reason} (${path} was restored, but ${caveats.join(', and ')})` };
		// Durably restored AND the daemon is back on the original file: the host is as it
		// was found, so the `changed` flags `runAll` set on the way in no longer describe
		// it. Carried through, they had the UI warn that part of a cleanly undone save
		// might still be applied — a caveat about a state that does not exist.
		return { ...result('error', reason), ...(r.steps ? { steps: r.steps } : {}) };
	}
	await fileChange(rollback.discard);
	return r;
}
