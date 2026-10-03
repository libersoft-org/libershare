import { describe, expect, test } from 'bun:test';
import { LinuxTimeJobWorker } from '../../src/native/linux/time-mutation-jobs.ts';
import { DBusTransportError, variant, type DBusReply, type DBusRequest, type DBusSignal, type SystemBus } from '../../src/native/linux/dbus.ts';

const ROOT = '/org/freedesktop/systemd1';
const UNIT = 'systemd-timesyncd.service';
const OTHER = 'chronyd.service';
const JOB = `${ROOT}/job/42`;
const owner = ':1.42';

function answer(signature = '', values: DBusReply['values'] = []): DBusReply {
	return { type: 'method_return', sender: owner, signature, values, errorName: null, errorMessage: null };
}

function fixture() {
	const calls: DBusRequest[] = [];
	const active = new Map([[UNIT, 'active'], [OTHER, 'inactive']]);
	let enabled = true;
	let jobLists = 0;
	let closed = 0;
	let serviceResult = 'success';
	let mutation: (request: DBusRequest) => Promise<DBusReply> = async request => request.member === 'RestartUnit' ? answer('o', [JOB]) : answer();
	let jobs: () => DBusReply = () => answer('a(usssoo)', [[]]);
	let afterWriteError = false;
	let written = false;
	let signal: ((value: DBusSignal) => void) | undefined;
	let signalFailure: ((error: Error) => void) | undefined;
	const sendRemoved = (path = JOB, unit = UNIT, result = 'done') => signal?.({ type: 'signal', sender: owner, path: ROOT, interface: 'org.freedesktop.systemd1.Manager', member: 'JobRemoved', signature: 'uoss', values: [42, path, unit, result] });
	const bus: Pick<SystemBus, 'call' | 'close' | 'subscribe'> = {
		async call(request) {
			calls.push(request);
			if (request.kind === 'mutation') { written = true; return mutation(request); }
			if (written && afterWriteError) throw new DBusTransportError('read connection gone', 'before-send', false);
			switch (request.member) {
				case 'GetAll': return answer('a{sv}', [{}]);
				case 'GetNameOwner': return answer('s', [owner]);
				case 'GetId': return answer('s', ['a'.repeat(32)]);
				case 'GetConnectionUnixProcessID': return answer('u', [42]);
				case 'LoadUnit': return answer('o', [`${ROOT}/unit/${request.args![0] as string}`]);
				case 'ListJobs': jobLists++; return jobs();
				case 'Subscribe': return answer();
				case 'Get': {
					const unit = request.path.slice(`${ROOT}/unit/`.length);
					const property = request.args![1];
					const value = property === 'Id' ? unit : property === 'LoadState' ? 'loaded' : property === 'ActiveState' ? active.get(unit)! : property === 'NTP' ? enabled : property === 'Result' ? serviceResult : null;
					if (value === null) throw new Error(`Unexpected property ${property}`);
					return answer('v', [variant(typeof value === 'boolean' ? 'b' : 's', value)]);
				}
				default: throw new Error(`Unexpected method ${request.member}`);
			}
		},
		subscribe(_match, onSignal, onError) { signal = onSignal; signalFailure = onError; return { close() { closed++; signal = undefined; } }; },
		close() {},
	};
	const worker = new LinuxTimeJobWorker(() => bus, pid => ({ pid, started: 'linux-starttime:123' }), async () => [UNIT, OTHER], async () => {});
	const bind = async (service: 'systemd1' | 'timedate1') => worker.bind({ options: { bus: 'system' }, destination: `org.freedesktop.${service}`, path: `/org/freedesktop/${service}`, interface: `org.freedesktop.${service}${service === 'systemd1' ? '.Manager' : ''}`, timeoutMs: 1000 });
	return {
		worker, calls, active, sendRemoved,
		closed: () => closed, jobLists: () => jobLists,
		setMutation: (fn: typeof mutation) => { mutation = fn; },
		setJobs: (fn: typeof jobs) => { jobs = fn; },
		setEnabled: (value: boolean) => { enabled = value; },
		setServiceResult: (value: string) => { serviceResult = value; },
		failRead: () => { afterWriteError = true; },
		failSignals: () => signalFailure?.(new Error('signal connection lost')),
		setNtp: async (value = true) => worker.setNtp({ timedated: await bind('timedate1'), systemd: await bind('systemd1'), enabled: value, readTimeoutMs: 1000 }),
		restart: async () => worker.restart({ endpoint: await bind('systemd1'), unit: UNIT, readTimeoutMs: 1000 }),
	};
}

describe('native SetNTP completion', () => {
	test('waits for every provider and ignores unrelated jobs', async () => {
		const f = fixture();
		f.setJobs(() => answer('a(usssoo)', [f.jobLists() === 1 ? [[7, OTHER, 'stop', 'running', `${ROOT}/job/7`, `${ROOT}/unit/other`]] : [[9, 'unrelated.service', 'start', 'running', `${ROOT}/job/9`, `${ROOT}/unit/unrelated`]]]));
		expect((await f.setNtp()).kind).toBe('ok');
		expect(f.jobLists()).toBe(2);
		const sent = f.calls.find(call => call.kind === 'mutation')!;
		expect(sent.destination).toBe(owner);
		expect('timeoutUsec' in sent).toBe(false);
		f.worker.close();
	});

	test.each(['AccessDenied', 'Timeout', 'Failed'])('authenticated %s remains unknown until a new boot', async name => {
		const f = fixture();
		f.setMutation(async () => ({ ...answer(), type: 'error', errorName: `org.freedesktop.DBus.Error.${name}`, errorMessage: name }));
		expect(await f.setNtp()).toMatchObject({ kind: 'unknown', endRule: { kind: 'boot' } });
		expect(f.jobLists()).toBe(0);
		f.worker.close();
	});

	test.each(['InvalidArgs', 'InteractiveAuthorizationRequired'])('%s is a confirmed pre-write refusal', async name => {
		const f = fixture();
		f.setMutation(async () => ({ ...answer(), type: 'error', errorName: `org.freedesktop.DBus.Error.${name}`, errorMessage: name }));
		expect(await f.setNtp()).toMatchObject({ stateMayHaveChanged: false });
		expect(f.jobLists()).toBe(0);
		f.worker.close();
	});

	test('a failed read after the successful write does not become an unsent mutation', async () => {
		const f = fixture();
		f.failRead();
		expect(await f.setNtp()).toMatchObject({ kind: 'unknown', endRule: { kind: 'boot' } });
		f.worker.close();
	});

	test('empty jobs and NTP=true do not hide another running provider', async () => {
		const f = fixture();
		f.active.set(OTHER, 'deactivating');
		expect(await f.setNtp()).toMatchObject({ kind: 'failed', stateMayHaveChanged: true });
		f.worker.close();
	});
});

describe('native RestartUnit completion', () => {
	test('captures JobRemoved before the reply and releases its subscription', async () => {
		const f = fixture();
		f.setMutation(async () => { f.sendRemoved(); return answer('o', [JOB]); });
		expect((await f.restart()).kind).toBe('ok');
		expect(f.closed()).toBe(1);
		expect(f.calls.findIndex(call => call.member === 'Subscribe')).toBeLessThan(f.calls.findIndex(call => call.member === 'RestartUnit'));
		f.worker.close();
	});

	test('a different job for the same unit cannot finish the restart', async () => {
		const f = fixture();
		f.setMutation(async () => { f.sendRemoved(`${ROOT}/job/41`); queueMicrotask(() => f.failSignals()); return answer('o', [JOB]); });
		expect(await f.restart()).toMatchObject({ kind: 'unknown', endRule: { kind: 'boot' } });
		expect(f.closed()).toBe(1);
		f.worker.close();
	});

	test.each(['failed', 'canceled', 'timeout'])('a terminal %s job is a known failure', async result => {
		const f = fixture();
		f.setMutation(async () => { f.sendRemoved(JOB, UNIT, result); return answer('o', [JOB]); });
		expect(await f.restart()).toMatchObject({ kind: 'failed', stateMayHaveChanged: true });
		f.worker.close();
	});

	test('done requires the service to be active and Result=success', async () => {
		for (const [state, result] of [['failed', 'success'], ['active', 'exit-code']]) {
			const f = fixture();
			f.active.set(UNIT, state!); f.setServiceResult(result!);
			f.setMutation(async () => { f.sendRemoved(); return answer('o', [JOB]); });
			expect(await f.restart()).toMatchObject({ kind: 'failed', stateMayHaveChanged: true });
			f.worker.close();
		}
	});
});
