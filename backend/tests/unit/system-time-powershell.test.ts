import { describe, expect, it } from 'bun:test';
import { buildSetClockCommands, runAll } from '../../src/system-time.ts';
import { run, type RunOutcome } from '../../src/system-time-common.ts';

describe.if(process.platform === 'win32')('PowerShell clock error transport', () => {
	it.each([
		{ exception: "[System.ComponentModel.Win32Exception]::new(1314, 'Opravneni neni dostupne')", code: 1314, outcome: 'permission-denied' },
		{ exception: "[System.ComponentModel.Win32Exception]::new(5, 'Zugriff verweigert')", code: 5, outcome: 'permission-denied' },
		{ exception: "[System.Exception]::new('Wrapper', [System.ComponentModel.Win32Exception]::new(1314, 'Privileges absents'))", code: 1314, outcome: 'permission-denied' },
		{ exception: "[System.UnauthorizedAccessException]::new('Acceso denegado')", code: 5, outcome: 'permission-denied' },
		{ exception: "[System.ComponentModel.Win32Exception]::new(87, 'Bad parameter')", code: 87, outcome: 'error' },
		{ exception: "[System.ComponentModel.Win32Exception]::new(0, 'Invalid zero error')", code: 1, outcome: 'error' },
		{ exception: "[System.Exception]::new('Other failure')", code: 1, outcome: 'error' },
	])('preserves exception codes through powershell.exe: $code / $outcome', async ({ exception, code, outcome }) => {
		// A function shadows the system cmdlet; these tests never call the real Set-Date.
		const fixture = `function Set-Date { [CmdletBinding()] param([datetime]$Date) throw ${exception} }; `;
		const commands = buildSetClockCommands('win32', { year: 2026, month: 9, day: 9, hours: 12, minutes: 34, seconds: 56 });
		let observed: RunOutcome | undefined;
		const result = await runAll('win32', commands, async (cmd, args) => {
			observed = await run(cmd, [...args.slice(0, -1), fixture + args.at(-1)]);
			return observed;
		});
		expect(observed).toMatchObject({ kind: 'failed', code: 1 });
		if (observed?.kind === 'failed') expect(observed.output.split(/\r?\n/)).toContain(`LISH_TIME_WIN32_ERROR=${code}`);
		expect(result).toMatchObject({ success: false, outcome });
	});
	it('keeps successful clock command completion successful', async () => {
		const fixture = "function Set-Date { [CmdletBinding()] param([datetime]$Date) if ($Date.ToString('yyyy-MM-ddTHH:mm:ss') -ne '2026-09-09T12:34:56') { throw 'Wrong date' } }; ";
		const result = await runAll('win32', buildSetClockCommands('win32', { year: 2026, month: 9, day: 9, hours: 12, minutes: 34, seconds: 56 }), (cmd, args) => run(cmd, [...args.slice(0, -1), fixture + args.at(-1)]));
		expect(result.success).toBe(true);
	});
});
