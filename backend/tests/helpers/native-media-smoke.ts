import { NativeWorkerChannel } from '../../src/native/worker-host.ts';
import { readCoreWlanWifi } from '../../src/system-network-corewlan.ts';
import { displayEnvironment } from '../../src/native/linux/gio.ts';
import type { MixerResult } from '../../src/system-volume.ts';

const platform = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux';
const reader = new NativeWorkerChannel('read');
const writer = new NativeWorkerChannel('mutation');
let events = 0;
const monitor = new NativeWorkerChannel('mutation', undefined, {
	onEvent: event => {
		if (event.event === 'linux.volume.changed') events++;
	},
});
try {
	if (process.argv[2] === 'open') {
		await reader.call({ method: `${platform}.open`, args: { path: process.argv[3], environment: displayEnvironment(process.env), timeoutMs: 10000 } }, 10000);
		console.log(JSON.stringify({ accepted: true }));
	} else if (process.argv[2] === 'corewlan') {
		const interfaces = await readCoreWlanWifi();
		console.log(JSON.stringify({ interfaces: interfaces.map(value => ({ device: value.device, configurable: value.configurable, radio: value.wifi.radio })) }));
	} else if (process.argv[2] === 'audio' || process.argv[2] === 'monitor') {
		const read = (): Promise<MixerResult> => reader.call({ method: `${platform}.volume.read`, args: { timeoutMs: 4900 } }, 5000);
		const write = (percent: number): Promise<MixerResult> => writer.call({ method: `${platform}.volume.write`, args: { percent, timeoutMs: 5000 } });
		const before = await read();
		if (before.kind !== 'ok' || before.volume === null) throw new Error('The test requires an available audio output');
		if (process.argv[2] === 'monitor') await monitor.call({ method: 'linux.volume.monitor.start' });
		let changed: MixerResult | undefined;
		let restored: MixerResult;
		try {
			changed = await write(before.volume === 37 ? 38 : 37);
			console.log(JSON.stringify({ before, changed, readback: await read() }));
		} finally {
			restored = await write(before.volume);
			console.log(JSON.stringify({ restored, readback: await read() }));
			if (process.argv[2] === 'monitor') {
				await Bun.sleep(100);
				await monitor.call({ method: 'linux.volume.monitor.stop' });
				const stoppedEvents = events;
				await Bun.sleep(30);
				console.log(JSON.stringify({ events, noEventsAfterStop: events === stoppedEvents }));
			}
		}
	} else throw new Error('Expected open, audio, monitor, or corewlan');
} finally {
	reader.close();
	writer.close();
	monitor.close();
}
