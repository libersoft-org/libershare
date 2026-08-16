import { describe, expect, it } from 'bun:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CodedError, ErrorCodes } from '@shared';
import { redactSecrets, run, scrubChildError } from '../../src/system-network.ts';

const execFileAsync = promisify(execFile);

/**
 * A Wi-Fi passphrase reaches `nmcli` as an argv entry, and `execFile` builds both
 * `Error.message` and `error.cmd` out of the whole command line. These cases run
 * REAL failing child processes — one that exits non-zero, one that is killed by
 * the timeout — and assert the secret survives in none of the text the backend
 * then logs or sends to the client.
 *
 * The timeout case is the one that used to leak: a killed process writes no
 * stderr, so the detail fell back to the message holding the full argv.
 */
const SECRET = 'correct-horse-battery-staple';

/** Every string a failure could leak through, in one blob. */
function everything(err: unknown, detail: string): string {
	const failure = err as Record<string, unknown>;
	return [detail, (err as Error).message, String(failure['cmd'] ?? ''), String(failure['stdout'] ?? ''), String(failure['stderr'] ?? ''), JSON.stringify(failure, Object.getOwnPropertyNames(failure))].join('\n');
}

async function failingRun(script: string, timeout: number): Promise<{ detail: string; raw: unknown }> {
	let raw: unknown = null;
	const detail = await run(async () => {
		try {
			await execFileAsync(process.execPath, ['-e', script, SECRET], { timeout });
		} catch (err) {
			raw = err;
			throw err;
		}
	}, [SECRET]).then(
		() => '',
		(err: CodedError) => {
			expect(err).toBeInstanceOf(CodedError);
			expect(err.code).toBe(ErrorCodes.NETCONFIG_FAILED);
			return `${err.detail ?? ''}\n${err.message}`;
		}
	);
	return { detail, raw };
}

describe('redactSecrets', () => {
	it('replaces every occurrence, not just the first', () => {
		expect(redactSecrets(`a ${SECRET} b ${SECRET}`, [SECRET])).toBe('a <redacted> b <redacted>');
	});

	it('leaves text alone when there is nothing to redact', () => {
		expect(redactSecrets('nmcli: Connection activation failed', [SECRET])).toBe('nmcli: Connection activation failed');
	});

	it('ignores an empty secret rather than redacting between every character', () => {
		// An open network is joined with an empty password, and splitting on '' would
		// turn the whole message into a wall of <redacted>.
		expect(redactSecrets('plain text', [''])).toBe('plain text');
	});
});

describe('scrubChildError', () => {
	it('clears the secret out of a nested cause', () => {
		const inner = new Error(`inner ${SECRET}`);
		const outer = new Error('outer', { cause: inner });
		scrubChildError(outer, [SECRET]);
		expect(inner.message).not.toContain(SECRET);
	});

	it('clears the secret out of spawnargs', () => {
		const err = Object.assign(new Error('boom'), { spawnargs: ['nmcli', 'password', SECRET] });
		scrubChildError(err, [SECRET]);
		expect(err.spawnargs).toEqual(['nmcli', 'password', '<redacted>']);
	});
});

describe('run with a secret-bearing child process', () => {
	it('keeps the passphrase out of everything a non-zero exit produces', async () => {
		const { detail, raw } = await failingRun('console.error("Error: Connection activation failed"); process.exit(4)', 15000);
		expect(raw).not.toBeNull();
		expect(detail).toContain('Connection activation failed');
		expect(everything(raw, detail)).not.toContain(SECRET);
	});

	it('keeps the passphrase out of everything a timeout produces', async () => {
		// The failure mode this exists for: a killed process writes no stderr, so the
		// detail is built from the message execFile assembled out of the whole argv.
		const { detail, raw } = await failingRun('setTimeout(() => {}, 60000)', 700);
		expect(raw).not.toBeNull();
		expect(detail.length).toBeGreaterThan(0);
		expect(everything(raw, detail)).not.toContain(SECRET);
	});
});
