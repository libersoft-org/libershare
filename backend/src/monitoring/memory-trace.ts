// Periodic memory diagnostics. Writes one JSON line per sample to a dedicated
// trace file and stdout. Before each sample we force a full GC (Bun.gc(true))
// and log both pre/post RSS so we can distinguish retained memory from
// uncollected garbage. Captures:
//   - process.memoryUsage() — rss, heapTotal, heapUsed, external, arrayBuffers
//   - Libp2p internals — peerstore, gossipsub mcache/mesh/peers, DHT routing table
//   - Internal collections — dcutrPeers, bootstrapPeerIDs, topicHandlers,
//     peer-tracker entries/cumulativeBytes/subscriptions
//   - Downloader fleet — count, per-downloader queue/peers/retry counters
// Goal: correlate RSS/heap growth with specific collection growth.

import { appendFile } from 'node:fs/promises';

export type MemTraceSource = () => Record<string, unknown> | Promise<Record<string, unknown>>;

const sources = new Map<string, MemTraceSource>();
let timer: ReturnType<typeof setInterval> | null = null;
let logPath: string | null = null;
let logToStdout = true;
let forceGcEnabled = true;

export function registerMemTraceSource(name: string, fn: MemTraceSource): void {
	sources.set(name, fn);
}

export function unregisterMemTraceSource(name: string): void {
	sources.delete(name);
}

function toMB(bytes: number): number {
	return +(bytes / 1048576).toFixed(1);
}

function tryForceGc(): void {
	if (!forceGcEnabled) return;
	const bun = (globalThis as any).Bun;
	if (bun && typeof bun.gc === 'function') {
		try {
			bun.gc(true);
		} catch {
			/* ignore */
		}
		return;
	}
	const g = (globalThis as any).gc;
	if (typeof g === 'function') {
		try {
			g();
		} catch {
			/* ignore */
		}
	}
}

async function collect(): Promise<Record<string, unknown>> {
	// Snapshot BEFORE forced GC.
	const preMem = process.memoryUsage();
	const gcStart = Date.now();
	tryForceGc();
	const gcMs = Date.now() - gcStart;
	// Snapshot AFTER forced GC — difference tells us how much was garbage.
	const mem = process.memoryUsage();
	const snap: Record<string, unknown> = {
		ts: new Date().toISOString(),
		uptime_s: Math.round(process.uptime()),
		pid: process.pid,
		rss_mb: toMB(mem.rss),
		heap_used_mb: toMB(mem.heapUsed),
		heap_total_mb: toMB(mem.heapTotal),
		external_mb: toMB(mem.external),
		array_buffers_mb: toMB(mem.arrayBuffers ?? 0),
		pre_gc_rss_mb: toMB(preMem.rss),
		pre_gc_heap_used_mb: toMB(preMem.heapUsed),
		pre_gc_external_mb: toMB(preMem.external),
		pre_gc_array_buffers_mb: toMB(preMem.arrayBuffers ?? 0),
		gc_reclaimed_rss_mb: toMB(preMem.rss - mem.rss),
		gc_reclaimed_heap_mb: toMB(preMem.heapUsed - mem.heapUsed),
		gc_ms: gcMs,
	};
	for (const [name, fn] of sources) {
		try {
			const data = await fn();
			for (const [k, v] of Object.entries(data)) snap[`${name}.${k}`] = v;
		} catch (err) {
			snap[`${name}.error`] = (err as Error)?.message ?? String(err);
		}
	}
	return snap;
}

async function writeSample(): Promise<void> {
	const snap = await collect();
	const line = JSON.stringify(snap);
	// Per-sample output is DEBUG — INFO is reserved for events worth a quick scroll.
	// The JSONL file (logPath) still captures every sample regardless of log level.
	if (logToStdout) console.debug(`[MEM-TRACE] ${line}`);
	if (logPath) {
		try {
			await appendFile(logPath, line + '\n');
		} catch (err) {
			console.error('[MEM-TRACE] write failed:', (err as Error).message);
		}
	}
}

export function startMemoryTrace(opts: { filePath?: string; intervalMs?: number; stdout?: boolean; forceGc?: boolean } = {}): void {
	if (timer) return;
	logPath = opts.filePath ?? null;
	logToStdout = opts.stdout ?? true;
	forceGcEnabled = opts.forceGc ?? true;
	const interval = opts.intervalMs ?? 30_000;
	// Kick an immediate baseline sample.
	void writeSample();
	timer = setInterval(() => void writeSample(), interval);
	// Intentionally do NOT unref() the timer. In Bun runtime, unref() on
	// setInterval prevents the callback from firing reliably after the first
	// tick, producing a memory-trace.jsonl with only the initial uptime=0
	// entry. Keeping the ref is fine — the timer is cleared on stopMemoryTrace().
	console.log(`[MEM-TRACE] started (interval=${interval}ms, file=${logPath ?? 'none'}, stdout=${logToStdout}, forceGc=${forceGcEnabled})`);
}

export function stopMemoryTrace(): void {
	if (timer) clearInterval(timer);
	timer = null;
}
