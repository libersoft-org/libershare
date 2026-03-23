import os from 'os';
import { statfs } from 'fs/promises';
import type { SystemRAMInfo, SystemStorageInfo, SystemCPUInfo } from '@shared';
import type { Settings } from '../settings.ts';
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

	function getRamInfo(): SystemRAMInfo {
		const total = os.totalmem();
		const free = os.freemem();
		return { used: total - free, total };
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
		const downloadPath = settings.get('storage.downloadPath');
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
