/**
 * Integration-test preload.
 *
 * libp2p's ReconnectQueue aborts its pending dial jobs inside node.stop() and
 * the AbortError escapes as an unhandled rejection ("Unhandled error between
 * tests"), failing otherwise-green runs. Swallow exactly that shutdown noise;
 * every other unhandled rejection still propagates.
 */
function isShutdownAbortNoise(err: any): boolean {
	const stack = String(err?.stack ?? '');
	return err?.name === 'AbortError' && (stack.includes('reconnect-queue') || stack.includes('queue\\job.js') || stack.includes('queue/job.js'));
}

process.on('unhandledRejection', (err: any) => {
	if (isShutdownAbortNoise(err)) return;
	throw err;
});

process.on('uncaughtException', (err: any) => {
	if (isShutdownAbortNoise(err)) return;
	throw err;
});
