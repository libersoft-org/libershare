const calls = [];
const supportedValuesOf = Intl.supportedValuesOf;
Intl.supportedValuesOf = key => supportedValuesOf(key).filter(value => key !== 'timeZone' || value !== 'UTC');
const deadline = setTimeout(() => process.exit(2), 5000);
try {
	const { listSystemTimezones, setSystemTimezone } = await import('../../src/system-time.ts');
	const utcAvailable = listSystemTimezones().includes('UTC');
	const result = await setSystemTimezone('UTC', async operation => {
		calls.push(operation);
		return { success: true, outcome: 'ok', message: null };
	});
	console.log(JSON.stringify({ canonicalIncludesUtc: Intl.supportedValuesOf('timeZone').includes('UTC'), utcResolves: new Intl.DateTimeFormat('en', { timeZone: 'UTC' }).resolvedOptions().timeZone === 'UTC', utcAvailable, result, calls }));
} finally {
	clearTimeout(deadline);
}
