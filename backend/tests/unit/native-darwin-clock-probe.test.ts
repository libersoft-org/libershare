import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { DarwinClockEnvironmentError, type DarwinClockReference } from '../../src/native/darwin/time-native.ts';
import { evaluateDarwinClockProbe, parseDarwinClockProbeReply, prepareDarwinClockSafely, readDarwinClockProbeOutput, validDarwinClockProbeRequest, type DarwinClockProbeRequest } from '../../src/native/darwin/time-clock-probe.ts';
import { executeDarwinClockWrite, type DarwinClockWriteDeps } from '../../src/native/darwin/time-worker.ts';
import { selfProcessCommand } from '../../src/native/self-process.ts';

const reference: DarwinClockReference = { localDate: '2026-10-03', zoneSha256: 'a'.repeat(64), bootId: 'darwin-boot:00000000-0000-4000-8000-000000000001' };
const request: DarwinClockProbeRequest = { version: 1, clock: { hours: 12, minutes: 34, seconds: 56 }, reference };
const target = Date.UTC(2026, 9, 3, 10, 34, 56);

test('clock probe accepts only a closed clock and host-reference request', () => {
	expect(validDarwinClockProbeRequest(request)).toBe(true);
	for (const patch of [{ version: 2 }, { clock: { hours: 24, minutes: 0, seconds: 0 } }, { clock: { ...request.clock, date: '2026-10-03' } }, { reference: { ...reference, zoneSha256: 'x' } }, { path: '/tmp/input' }]) expect(validDarwinClockProbeRequest({ ...request, ...patch })).toBe(false);
});
test('the read-only child refuses a changed reference before and after mktime', () => {
	let converted = 0;
	const convert = () => {
		converted++;
		return target;
	};
	expect(() => evaluateDarwinClockProbe(request, () => ({ ...reference, localDate: '2026-10-04' }), convert)).toThrow('reference changed');
	expect(converted).toBe(0);
	let reads = 0;
	expect(() => evaluateDarwinClockProbe(request, () => (++reads === 1 ? reference : { ...reference, zoneSha256: 'b'.repeat(64) }), convert)).toThrow('reference changed');
	expect(converted).toBe(1);
});
test('clean native conversion does not launch a process; only environment failures do', async () => {
	let probes = 0;
	const probe = async (input: DarwinClockProbeRequest) => {
		probes++;
		expect(input).toEqual(request);
		return { version: 1 as const, targetUtcMs: target, reference };
	};
	expect((await prepareDarwinClockSafely(request.clock, { reference: () => reference, convert: () => target, probe })).targetUtcMs).toBe(target);
	expect(probes).toBe(0);
	expect(
		(
			await prepareDarwinClockSafely(request.clock, {
				reference: () => reference,
				convert: () => {
					throw new DarwinClockEnvironmentError('C TZ is set');
				},
				probe,
			})
		).targetUtcMs
	).toBe(target);
	expect(probes).toBe(1);
	await expect(
		prepareDarwinClockSafely(request.clock, {
			reference: () => reference,
			convert: () => {
				throw new Error('Unreadable host timezone');
			},
			probe,
		})
	).rejects.toThrow('Unreadable');
	expect(probes).toBe(1);
});
test('a late probe result cannot cross a date, boot or timezone change', async () => {
	for (const patch of [{ localDate: '2026-10-04' }, { bootId: 'darwin-boot:00000000-0000-4000-8000-000000000002' }, { zoneSha256: 'b'.repeat(64) }]) {
		let reads = 0;
		await expect(
			prepareDarwinClockSafely(request.clock, {
				reference: () => (++reads === 1 ? reference : { ...reference, ...patch }),
				convert: () => {
					throw new DarwinClockEnvironmentError('TZ');
				},
				probe: async () => ({ version: 1, targetUtcMs: target, reference }),
			})
		).rejects.toThrow('changed during clock conversion');
	}
});
test('probe output is bounded across chunks and bound to the requested reference', async () => {
	const reply = JSON.stringify({ version: 1, targetUtcMs: target, reference });
	const stream = (parts: Uint8Array[]) =>
		new ReadableStream<Uint8Array>({
			start(controller) {
				for (const part of parts) controller.enqueue(part);
				controller.close();
			},
		});
	expect(parseDarwinClockProbeReply(await readDarwinClockProbeOutput(stream([Buffer.from(reply.slice(0, 20)), Buffer.from(reply.slice(20))])), reference).targetUtcMs).toBe(target);
	await expect(readDarwinClockProbeOutput(stream([new Uint8Array(4000), new Uint8Array(97)]))).rejects.toThrow('too large');
	for (const value of [
		{ version: 2, targetUtcMs: target, reference },
		{ version: 1, targetUtcMs: target, reference: { ...reference, localDate: '2026-10-04' } },
		{ version: 1, targetUtcMs: target, reference, extra: true },
	])
		expect(() => parseDarwinClockProbeReply(JSON.stringify(value), reference)).toThrow();
});

function writerFixture(change: () => void = () => {}) {
	let zone = 'original',
		active = false,
		current = { ...reference },
		writes = 0;
	const deps: DarwinClockWriteDeps = {
		zoneFingerprint: () => zone,
		reference: () => current,
		ntpEnabled: () => active,
		convert: async () => {
			change();
			return { version: 1, targetUtcMs: target, reference };
		},
		uptime: () => 12345,
		set: () => {
			writes++;
			return 0;
		},
	};
	return {
		deps,
		writes: () => writes,
		zone: () => {
			zone = 'changed';
		},
		ntp: () => {
			active = true;
		},
		reference: (patch: Partial<DarwinClockReference>) => {
			current = { ...current, ...patch };
		},
	};
}
test('the clock writer checks timezone, NTP, date and boot again after conversion', async () => {
	for (const kind of ['zone', 'ntp', 'date', 'boot'] as const) {
		const f = writerFixture(() => {
			if (kind === 'zone') f.zone();
			else if (kind === 'ntp') f.ntp();
			else f.reference(kind === 'date' ? { localDate: '2026-10-04' } : { bootId: 'changed' });
		});
		const operation = executeDarwinClockWrite({ kind: 'clock', clock: request.clock, zoneFingerprint: 'original' }, f.deps);
		if (kind === 'ntp') expect((await operation).outcome).toMatchObject({ kind: 'failed', outcome: 'auto-sync-enabled', stateMayHaveChanged: false });
		else await expect(operation).rejects.toThrow('changed during clock preparation');
		expect(f.writes()).toBe(0);
	}
});
test('a failed clock conversion cannot call settimeofday', async () => {
	const f = writerFixture();
	f.deps.convert = async () => {
		throw new Error('probe timeout');
	};
	await expect(executeDarwinClockWrite({ kind: 'clock', clock: request.clock, zoneFingerprint: 'original' }, f.deps)).rejects.toThrow('probe timeout');
	expect(f.writes()).toBe(0);
});
test('a verified conversion records the uptime at the actual clock write', async () => {
	const f = writerFixture();
	expect(await executeDarwinClockWrite({ kind: 'clock', clock: request.clock, zoneFingerprint: 'original' }, f.deps)).toMatchObject({ outcome: { kind: 'ok' }, clock: { targetUtcMs: target, hostUptimeMs: 12345, bootId: reference.bootId } });
	expect(f.writes()).toBe(1);
});

test('source probe commands point to the real app entry', () => {
	const command = selfProcessCommand('--clock-probe', JSON.stringify(request));
	expect(command[0]).toBe(process.execPath);
	expect(command[1]).toBe(resolve(import.meta.dir, '../../src/app.ts'));
	expect(command.slice(2)).toEqual(['--clock-probe', JSON.stringify(request)]);
});
for (const entry of ['app.ts', 'network-helper.ts'])
	test(`invalid clock probe exits before ${entry} startup`, async () => {
		const child = Bun.spawn([process.execPath, resolve(import.meta.dir, '../../src', entry), '--clock-probe', 'not-json'], { stdout: 'pipe', stderr: 'pipe' });
		const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
		try {
			expect(await child.exited).toBe(3);
			expect(await new Response(child.stdout).text()).toBe('');
			expect(await new Response(child.stderr).text()).toBe('');
		} finally {
			clearTimeout(timer);
		}
	});

test('the read-only probe clears TZ and kills only its own child after five seconds', async () => {
	const script = `
		import {runDarwinClockProbeChild} from './src/native/darwin/time-clock-probe.ts';
		const request=${JSON.stringify(request)};
		process.argv=[process.execPath,'app.ts','--clock-probe',JSON.stringify({version:1,clock:request.clock})];
		let resolveExit,streamController,code=null,killed=false,limit=null,hasTZ=true;
		const exited=new Promise(resolve=>{resolveExit=resolve});
		Bun.spawn=(command,options)=>{
			hasTZ=Object.hasOwn(options.env,'TZ');
			if(command[command.length-2]!=='--clock-probe')throw new Error('Wrong probe mode');
			return {stdout:new ReadableStream({start(controller){streamController=controller}}),exited,get exitCode(){return code},kill(signal){if(signal!=='SIGKILL')throw new Error('Wrong signal');killed=true;code=-9;streamController.close();resolveExit(-9)}};
		};
		globalThis.setTimeout=(callback,ms)=>{limit=ms;queueMicrotask(callback);return 1};globalThis.clearTimeout=()=>{};
		let error=null;try{await runDarwinClockProbeChild(request)}catch(value){error=value.message}
		console.log(JSON.stringify({killed,limit,hasTZ,error}));
	`;
	const child = Bun.spawn([process.execPath, '--eval', script], { cwd: resolve(import.meta.dir, '../..'), env: { ...process.env, TZ: 'UTC' }, stdout: 'pipe', stderr: 'pipe' });
	const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
	if (code !== 0) throw new Error(error);
	expect(JSON.parse(output)).toEqual({ killed: true, limit: 5000, hasTZ: false, error: 'The clock conversion probe timed out' });
});

test('a referenced clock child cannot start another child', async () => {
	const script = `
		import {runDarwinClockProbeChild} from './src/native/darwin/time-clock-probe.ts';
		const request=${JSON.stringify(request)};
		process.argv=[process.execPath,'app.ts','--clock-probe',JSON.stringify(request)];
		let spawned=false;
		Bun.spawn=()=>{spawned=true;throw new Error('Child launched')};
		let error=null;try{await runDarwinClockProbeChild(request)}catch(value){error=value.message}
		console.log(JSON.stringify({spawned,error}));
	`;
	const child = Bun.spawn([process.execPath, '--eval', script], { cwd: resolve(import.meta.dir, '../..'), stdout: 'pipe', stderr: 'pipe' });
	const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
	if (code !== 0) throw new Error(error);
	expect(JSON.parse(output)).toEqual({ spawned: false, error: 'Invalid recursive clock conversion request' });
});
