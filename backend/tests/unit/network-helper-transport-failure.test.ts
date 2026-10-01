import { expect, test } from 'bun:test';
import { helperTransportFailure } from '../../src/network-helper-client.ts';

for (const source of ['message', 'stderr', 'buffer'] as const) {
	test(`macOS cancellation survives a long command prefix through ${source}`, () => {
		const diagnostic = 'execution error: Uživatel zrušil operaci. (-128)\n';
		const command = `Command failed: /usr/bin/osascript -e ${'set argument to value; '.repeat(50)}`;
		const error = Object.assign(new Error(`${command}\n${diagnostic}`), source === 'message' ? {} : { stderr: source === 'buffer' ? Buffer.from(diagnostic) : diagnostic });
		const result = helperTransportFailure(error);
		expect(result.outcome).toBe('elevation-declined');
		expect(result.changed).toBeUndefined();
		expect(result.stateMayHaveChanged).toBeUndefined();
		expect(result.message!.length).toBeLessThanOrEqual(500);
	});
}

test('a cancellation-like argument does not hide a failure after launch', () => {
	const message = 'Command failed: /usr/bin/osascript -- helper-128\nexecution error: helper failed (1)\n';
	for (const error of [new Error(message), Object.assign(new Error(message), { stderr: 'execution error: helper failed (1)\n' })]) {
		const result = helperTransportFailure(error);
		expect(result.outcome).toBe('error');
		expect(result.stateMayHaveChanged).toBe(true);
	}
});
