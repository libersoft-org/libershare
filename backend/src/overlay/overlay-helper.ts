import { randomBytes } from 'node:crypto';
import { type Subprocess } from 'bun';
import { CodedError, ErrorCodes } from '@shared';
import { overlayBinaryPath } from './overlay-binary.ts';

/** Nebula needs a moment to bind its socket and reach the first lighthouse; anything longer is a broken start. */
const READY_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 5_000;
const CONTROL_TIMEOUT_MS = 10_000;

/** One tunnel as the helper reports it. */
export interface HelperHost {
	vpnAddrs: string[];
	name: string;
	/** Underlay address of a direct tunnel; absent when the tunnel goes through a relay. */
	remote?: string;
	relayedVia: string[];
}

export interface HelperStatus {
	hosts: HelperHost[];
	inboundPort: number;
}

/**
 * One running `lish-overlay run` process: the Nebula node of one protected lishnet.
 *
 * The process holds our stdin open; when this backend exits for any reason the pipe closes and the helper stops,
 * so no helper outlives the backend that started it.
 */
export class OverlayHelper {
	readonly token: string = randomBytes(32).toString('hex');
	dialPort = 0;
	private controlPort = 0;
	private proc: Subprocess<'pipe', 'pipe', 'pipe'> | null = null;
	private stopping = false;
	private readonly tag: string;

	private constructor(tag: string) {
		this.tag = tag;
	}

	/**
	 * Start the helper and wait until it reports its ports. `onExit` runs once if the process ends without
	 * {@link stop} having been called.
	 */
	static async start(opts: { configPath: string; port: number; tag: string; onExit: (code: number | null) => void }): Promise<OverlayHelper> {
		const helper = new OverlayHelper(opts.tag);
		const proc = Bun.spawn([overlayBinaryPath(), 'run', '--config', opts.configPath, '--port', String(opts.port)], {
			stdin: 'pipe',
			stdout: 'pipe',
			stderr: 'pipe',
			env: { ...process.env, LISH_OVERLAY_TOKEN: helper.token },
		});
		helper.proc = proc;
		const recent: string[] = [];
		void helper.pumpLog(proc.stderr, line => {
			recent.push(line);
			if (recent.length > 5) recent.shift();
		});
		const ready = helper.readReady(proc.stdout);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('the overlay helper did not start in time')), READY_TIMEOUT_MS)));
		const exited = proc.exited.then(code => {
			throw new Error(`the overlay helper exited with ${code}: ${recent.join(' | ')}`);
		});
		try {
			const ports = await Promise.race([ready, timeout, exited]);
			helper.dialPort = ports.dial;
			helper.controlPort = ports.control;
		} catch (err: any) {
			proc.kill();
			throw new CodedError(ErrorCodes.OVERLAY_HELPER_UNAVAILABLE, err?.message ?? String(err));
		} finally {
			clearTimeout(timer);
			exited.catch(() => {});
		}
		void proc.exited.then(code => {
			if (!helper.stopping) {
				console.error(`[Overlay ${helper.tag}] helper exited unexpectedly (${code})`);
				opts.onExit(code);
			}
		});
		return helper;
	}

	private async readReady(stdout: ReadableStream<Uint8Array>): Promise<{ control: number; dial: number }> {
		const reader = stdout.getReader();
		let text = '';
		for (;;) {
			const { value, done } = await reader.read();
			if (done) throw new Error('the overlay helper closed its output before it was ready');
			text += new TextDecoder().decode(value);
			const nl = text.indexOf('\n');
			if (nl < 0) continue;
			reader.releaseLock();
			const ready = JSON.parse(text.slice(0, nl));
			if (ready.event !== 'ready' || !Number.isInteger(ready.control) || !Number.isInteger(ready.dial)) throw new Error('unexpected first line from the overlay helper');
			return { control: ready.control, dial: ready.dial };
		}
	}

	/** Forward the helper's JSON log lines: warnings and errors as such, the rest at debug level. */
	private async pumpLog(stream: ReadableStream<Uint8Array>, remember: (line: string) => void): Promise<void> {
		const decoder = new TextDecoder();
		let pending = '';
		for await (const chunk of stream) {
			pending += decoder.decode(chunk, { stream: true });
			let nl: number;
			while ((nl = pending.indexOf('\n')) >= 0) {
				const line = pending.slice(0, nl).trim();
				pending = pending.slice(nl + 1);
				if (!line) continue;
				remember(line);
				let level = '';
				let msg = line;
				try {
					const parsed = JSON.parse(line);
					level = String(parsed.level ?? '').toLowerCase();
					msg = `${parsed.msg ?? ''} ${Object.entries(parsed)
						.filter(([k]) => !['time', 'level', 'msg'].includes(k))
						.map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
						.join(' ')}`;
				} catch {}
				const text = `[Overlay ${this.tag}] ${msg}`;
				if (level === 'error' || level === 'fatal') console.error(text);
				else if (level === 'warn' || level === 'warning') console.warn(text);
				else console.debug(text);
			}
		}
	}

	private async control(method: 'GET' | 'POST', path: string): Promise<any> {
		const res = await fetch(`http://127.0.0.1:${this.controlPort}${path}`, { method, headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS) });
		if (!res.ok) throw new Error(`overlay helper ${path}: HTTP ${res.status}`);
		return await res.json();
	}

	status(): Promise<HelperStatus> {
		return this.control('GET', '/status');
	}

	/** Re-read the configuration file: new hosts or revocations apply without dropping tunnels. */
	async reload(): Promise<void> {
		await this.control('POST', '/reload');
	}

	async setInboundPort(port: number): Promise<void> {
		await this.control('POST', `/inbound?port=${port}`);
	}

	isRunning(): boolean {
		return this.proc !== null && this.proc.exitCode === null && !this.stopping;
	}

	/** Stop the helper: ask it, close its pipe, and kill it if it is still there after a few seconds. */
	async stop(): Promise<void> {
		const proc = this.proc;
		if (!proc || this.stopping) return;
		this.stopping = true;
		await this.control('POST', '/stop').catch(() => {});
		try {
			proc.stdin.end();
		} catch {}
		const timer = setTimeout(() => proc.kill(), STOP_TIMEOUT_MS);
		await proc.exited;
		clearTimeout(timer);
	}
}
