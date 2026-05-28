/**
 * Decision returned by {@link resolveHealthcheckPort}. The probe should
 * exit immediately with `exit` if it is set; otherwise `port` carries the
 * resolved target for the localhost HTTP probe.
 */
export interface HealthcheckPortDecision {
	port: number;
	exit?: number;
	message?: string;
}

/**
 * Resolve the port the `--healthcheck` self-flag should probe.
 *
 * Priority:
 *   1. Explicit `--port` argument (already parsed into a number by app.ts).
 *   2. `BACKEND_PORT` environment variable, if it parses as a positive integer.
 *   3. Fallback to 1158 — the binary's own default elsewhere.
 *
 * A `--port 0` (random-port) configuration without a `BACKEND_PORT` env var
 * cannot be probed from a separate process: there is no way to discover the
 * actual bound port without intervening file/IPC. Returning a non-zero exit
 * code instead of guessing 1158 surfaces the misconfiguration to the
 * orchestrator instead of silently flapping the container.
 */
export function resolveHealthcheckPort(apiPort: number, backendPortEnv: string | undefined): HealthcheckPortDecision {
	if (apiPort > 0) return { port: apiPort };
	if (backendPortEnv !== undefined && backendPortEnv.length > 0) {
		const envPort = Number(backendPortEnv);
		if (Number.isFinite(envPort) && envPort > 0) return { port: envPort };
		// User explicitly set BACKEND_PORT but it didn't parse — surface that
		// rather than silently falling back to a default port the operator
		// might not be expecting.
		return {
			port: 0,
			exit: 2,
			message: `[Healthcheck] BACKEND_PORT="${backendPortEnv}" is not a positive integer; cannot probe`,
		};
	}
	// No explicit configuration — fall back to the binary's documented
	// default. Caller is presumed to also be running the server on 1158.
	return { port: 1158 };
}
