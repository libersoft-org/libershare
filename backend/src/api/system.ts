import os from 'os';
import type { SystemRAMInfo } from '@shared';
type BroadcastFn = (event: string, data: any) => void;
type HasSubscribersFn = (event: string) => boolean;
const RAM_INTERVAL_MS = 5000;
interface SystemHandlers {
	ram: () => SystemRAMInfo;
	startRAMPolling: () => void;
	stopRAMPolling: () => void;
}

export function initSystemHandlers(broadcast: BroadcastFn, hasSubscribers: HasSubscribersFn): SystemHandlers {
	let ramInterval: ReturnType<typeof setInterval> | null = null;

	function getRamInfo(): SystemRAMInfo {
		const total = os.totalmem();
		const free = os.freemem();
		return { used: total - free, total };
	}

	function startRAMPolling(): void {
		if (ramInterval) return;
		ramInterval = setInterval(() => {
			if (!hasSubscribers('system:ram')) return;
			broadcast('system:ram', getRamInfo());
		}, RAM_INTERVAL_MS);
	}

	function stopRAMPolling(): void {
		if (ramInterval) {
			clearInterval(ramInterval);
			ramInterval = null;
		}
	}

	return { ram: getRamInfo, startRAMPolling, stopRAMPolling };
}
