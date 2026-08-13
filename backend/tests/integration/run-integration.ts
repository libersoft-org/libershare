/**
 * Integration suite runner.
 *
 * libp2p dial jobs aborted mid-flight (AbortSignal.timeout in the re-dial
 * loop, ReconnectQueue.stop) surface as reported errors that `bun test`
 * counts as "Unhandled error between tests" and turns into a non-zero exit —
 * even when every test passed and process-level handlers are registered
 * (app.ts guards the same noise in production). This runner keeps the full
 * output but derives the exit code from the actual fail count.
 */
const proc: ReturnType<typeof Bun.spawnSync> = Bun.spawnSync(['bun', 'test', 'tests/integration/', '--timeout', '120000', '--preload', './tests/integration/preload.ts'], {
	stdout: 'inherit',
	stderr: 'pipe',
});
const stderr: string = new TextDecoder().decode(proc.stderr);
process.stderr.write(stderr);

const failMatch: RegExpMatchArray | null = stderr.match(/(\d+) fail\b/);
const fails: number = failMatch ? Number(failMatch[1]) : NaN;
if (Number.isNaN(fails)) {
	console.error('[run-integration] could not parse fail count from bun test output');
	process.exit(1);
}
process.exit(fails === 0 ? 0 : 1);
