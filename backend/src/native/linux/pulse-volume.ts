import type { MixerResult } from '../../system-volume.ts';
import { alsaVolume } from './alsa.ts';
import { PulseSession, PulseTimeout } from './pulse.ts';

export interface LinuxVolumeRequest {
	timeoutMs: number;
}
export interface LinuxVolumeWriteRequest extends LinuxVolumeRequest {
	percent: number;
}
export interface LinuxVolumeBackends {
	pulse(percent: number | undefined, deadline: number): Promise<number>;
	alsa(percent?: number): MixerResult;
	now(): number;
}
const backends: LinuxVolumeBackends = {
	async pulse(percent, deadline) {
		const session = new PulseSession();
		try {
			await session.ready(deadline);
			return percent === undefined ? (await session.sink(deadline)).volume : await session.write(percent, deadline);
		} finally {
			session.close();
		}
	},
	alsa: alsaVolume,
	now: () => performance.now(),
};

export async function linuxVolume(request: LinuxVolumeRequest, percent?: number, deps: LinuxVolumeBackends = backends): Promise<MixerResult> {
	if (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0) return { kind: 'error' };
	const deadline = deps.now() + Math.min(5000, request.timeoutMs);
	try {
		const volume = await deps.pulse(percent, deadline);
		if (deps.now() >= deadline) return { kind: 'error' };
		if (Number.isFinite(volume) && volume >= 0 && volume <= 100) return { kind: 'ok', volume };
	} catch (error) {
		if (error instanceof PulseTimeout || deps.now() >= deadline) return { kind: 'error' };
	}
	if (deps.now() >= deadline) return { kind: 'error' };
	try {
		const result = deps.alsa(percent);
		return deps.now() >= deadline ? { kind: 'error' } : result;
	} catch {
		return { kind: 'no-device' };
	}
}
export function readLinuxVolume(request: LinuxVolumeRequest): Promise<MixerResult> {
	return linuxVolume(request);
}
export function writeLinuxVolume(request: LinuxVolumeWriteRequest): Promise<MixerResult> {
	if (!Number.isFinite(request.percent)) return Promise.resolve({ kind: 'error' });
	return linuxVolume(request, Math.max(0, Math.min(100, Math.round(request.percent))));
}

export class PulseVolumeMonitor {
	private session: PulseSession | undefined;
	private timer: ReturnType<typeof setInterval> | undefined;
	private stopped = false;
	async start(changed: () => void, exited: () => void, timeoutMs = 5000): Promise<void> {
		if (this.session || this.stopped) throw new Error('Pulse monitor already started or stopped');
		const session = (this.session = new PulseSession());
		const deadline = performance.now() + timeoutMs;
		try {
			await session.ready(deadline);
			await session.subscribe(() => {
				if (!this.stopped) changed();
			}, deadline);
			this.timer = setInterval(() => {
				try {
					session.iterate();
				} catch {
					this.close();
					exited();
				}
			}, 10);
		} catch (error) {
			this.close();
			throw error;
		}
	}
	close(): void {
		this.stopped = true;
		clearInterval(this.timer);
		this.session?.close();
		this.session = undefined;
	}
}
