import { NativeWorkerChannel } from '../worker-host.ts';
import type { WindowsTimeSnapshot, WindowsTimeSnapshotRequest } from './time-state.ts';

// A timed-out native read must finish before this channel can dispatch another one.
const reader = new NativeWorkerChannel('read');
export function readWindowsTimeSnapshotAsync(request: WindowsTimeSnapshotRequest = {}, timeoutMs = 10000): Promise<WindowsTimeSnapshot> {
	return reader.call({ method: 'win32.time.snapshot', args: request }, timeoutMs);
}
