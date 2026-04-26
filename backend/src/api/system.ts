import os from 'os';
import { statfs } from 'fs/promises';
import { readFileSync } from 'fs';
import type { SystemRAMInfo, SystemStorageInfo, SystemCPUInfo } from '@shared';
import type { Settings } from '../settings.ts';
import { Utils } from '../utils.ts';
type BroadcastFn = (event: string, data: any) => void;
type HasSubscribersFn = (event: string) => boolean;
const POLL_INTERVAL_MS = 5000;
interface SystemHandlers {
	ram: () => SystemRAMInfo;
	storage: () => Promise<SystemStorageInfo>;
	cpu: () => SystemCPUInfo;
	startPolling: () => void;
	stopPolling: () => void;
}

export function initSystemHandlers(settings: Settings, broadcast: BroadcastFn, hasSubscribers: HasSubscribersFn): SystemHandlers {
	let pollInterval: ReturnType<typeof setInterval> | null = null;

	function getLinuxAvailableMem(): number | null {
		try {
			const meminfo = readFileSync('/proc/meminfo', 'utf8');
			const match = meminfo.match(/^MemAvailable:\s+(\d+)\s+kB/m);
			if (!match || !match[1]) return null;
			return parseInt(match[1], 10) * 1024;
		} catch {
			return null;
		}
	}

	// Reads a single integer from a cgroup file. Returns null on error or sentinel "max".
	function readCgroupNumber(path: string): number | null {
		try {
			const raw = readFileSync(path, 'utf8').trim();
			if (raw === 'max' || raw === '') return null;
			const n = parseInt(raw, 10);
			if (!Number.isFinite(n) || n <= 0) return null;
			return n;
		} catch {
			return null;
		}
	}

	// Detect cgroup memory limit + usage (Docker / containers). Returns null if unconstrained.
	// Tries cgroup v2 first, then v1. Treats limits >= host total as "no limit".
	function getCgroupRamInfo(hostTotal: number): SystemRAMInfo | null {
		// cgroup v2
		const v2Limit = readCgroupNumber('/sys/fs/cgroup/memory.max');
		if (v2Limit !== null && v2Limit < hostTotal) {
			const current = readCgroupNumber('/sys/fs/cgroup/memory.current');
			if (current !== null) {
				// memory.current includes page cache; subtract reclaimable to mirror MemAvailable semantics
				let used = current;
				try {
					const stat = readFileSync('/sys/fs/cgroup/memory.stat', 'utf8');
					const fileMatch = stat.match(/^file\s+(\d+)/m);
					if (fileMatch && fileMatch[1]) used -= parseInt(fileMatch[1], 10);
				} catch {}
				return { used: Math.max(0, used), total: v2Limit };
			}
		}
		// cgroup v1
		const v1Limit = readCgroupNumber('/sys/fs/cgroup/memory/memory.limit_in_bytes');
		if (v1Limit !== null && v1Limit < hostTotal) {
			const v1Usage = readCgroupNumber('/sys/fs/cgroup/memory/memory.usage_in_bytes');
			if (v1Usage !== null) {
				let used = v1Usage;
				try {
					const stat = readFileSync('/sys/fs/cgroup/memory/memory.stat', 'utf8');
					const cacheMatch = stat.match(/^total_inactive_file\s+(\d+)/m) ?? stat.match(/^cache\s+(\d+)/m);
					if (cacheMatch && cacheMatch[1]) used -= parseInt(cacheMatch[1], 10);
				} catch {}
				return { used: Math.max(0, used), total: v1Limit };
			}
		}
		return null;
	}

	function getRamInfo(): SystemRAMInfo {
		const hostTotal = os.totalmem();
		// Inside a memory-limited container, report container's limit + usage instead of host RAM.
		if (process.platform === 'linux') {
			const cgroup = getCgroupRamInfo(hostTotal);
			if (cgroup) return cgroup;
		}
		// On Linux, MemAvailable reflects truly usable memory (excludes reclaimable cache/buffers).
		// os.freemem() returns only MemFree, which makes used memory look much higher than reality.
		const available = process.platform === 'linux' ? getLinuxAvailableMem() : null;
		const free = available ?? os.freemem();
		return { used: hostTotal - free, total: hostTotal };
	}

	let prevCpuTimes: { idle: number; total: number } | null = null;

	function sampleCpuTimes(): { idle: number; total: number } {
		const cpus = os.cpus();
		let idle = 0;
		let total = 0;
		for (const cpu of cpus) {
			idle += cpu.times.idle;
			total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
		}
		return { idle, total };
	}

	function getCpuInfo(): SystemCPUInfo {
		const current = sampleCpuTimes();
		if (!prevCpuTimes) {
			prevCpuTimes = current;
			return { usage: 0 };
		}
		const idleDelta = current.idle - prevCpuTimes.idle;
		const totalDelta = current.total - prevCpuTimes.total;
		prevCpuTimes = current;
		return { usage: totalDelta > 0 ? Math.round(((totalDelta - idleDelta) / totalDelta) * 10000) / 100 : 0 };
	}

	// Take initial CPU sample so first poll has a valid delta
	prevCpuTimes = sampleCpuTimes();

	async function getStorageInfo(): Promise<SystemStorageInfo> {
		const downloadPath = Utils.expandHome(settings.get('storage.downloadPath'));
		const stats = await statfs(downloadPath);
		const total = stats.blocks * stats.bsize;
		const free = stats.bavail * stats.bsize;
		return { used: total - free, total };
	}

	function startPolling(): void {
		if (pollInterval) return;
		pollInterval = setInterval(async () => {
			if (hasSubscribers('system:cpu')) broadcast('system:cpu', getCpuInfo());
			if (hasSubscribers('system:ram')) broadcast('system:ram', getRamInfo());
			if (hasSubscribers('system:storage')) {
				try {
					broadcast('system:storage', await getStorageInfo());
				} catch {}
			}
		}, POLL_INTERVAL_MS);
	}

	function stopPolling(): void {
		if (pollInterval) {
			clearInterval(pollInterval);
			pollInterval = null;
		}
	}

	return { ram: getRamInfo, storage: getStorageInfo, cpu: getCpuInfo, startPolling, stopPolling };
}
