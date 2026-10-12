import { describe, expect, it } from 'bun:test';
import { CONNECTION_SILENCE_LIMIT_MS, ConnectionLiveness, withConnectionLiveness } from '../../../src/protocol/connection-liveness.ts';

/** A stand-in for a libp2p MultiaddrConnection: an EventTarget with a status and abort(). */
class FakeConnection extends EventTarget {
	status = 'open';
	readonly remoteAddr = { toString: (): string => '/ip4/192.0.2.5/tcp/9090' };
	abortedWith: Error | undefined;
	abort(err: Error): void {
		this.abortedWith = err;
		this.status = 'closed';
	}
	receive(): void {
		this.dispatchEvent(new Event('message'));
	}
	close(): void {
		this.status = 'closed';
		this.dispatchEvent(new Event('close'));
	}
}

describe('ConnectionLiveness', () => {
	it('closes a connection that has delivered nothing for the whole limit', () => {
		const watch = new ConnectionLiveness();
		const conn = new FakeConnection();
		watch.track(conn, 0);
		expect(watch.sweep(CONNECTION_SILENCE_LIMIT_MS - 1)).toBe(0);
		expect(watch.sweep(CONNECTION_SILENCE_LIMIT_MS)).toBe(1);
		expect(conn.abortedWith?.message).toContain('silent');
	});

	it('keeps a connection that keeps receiving, however long it lives', () => {
		const watch = new ConnectionLiveness();
		const conn = new FakeConnection();
		watch.track(conn, performance.now() - 10 * CONNECTION_SILENCE_LIMIT_MS);
		conn.receive();
		expect(watch.sweep(performance.now() + CONNECTION_SILENCE_LIMIT_MS - 1000)).toBe(0);
		expect(conn.abortedWith).toBeUndefined();
	});

	it('keeps watching a connection tracked before the sweep started', () => {
		const watch = new ConnectionLiveness();
		const conn = new FakeConnection();
		// The upgrader reports connections made while the node is still starting.
		watch.track(conn, 0);
		watch.start();
		try {
			expect(watch.sweep(CONNECTION_SILENCE_LIMIT_MS)).toBe(1);
		} finally {
			watch.stop();
		}
	});

	it('is not fooled by the system clock jumping', () => {
		const realNow = Date.now;
		const watch = new ConnectionLiveness();
		const fresh = new FakeConnection();
		const silent = new FakeConnection();
		try {
			watch.track(fresh);
			watch.track(silent, performance.now() - CONNECTION_SILENCE_LIMIT_MS - 5000);
			// A clock set a minute ahead makes no fresh connection look silent ...
			Date.now = (): number => realNow() + 60_000;
			// ... and one set a minute back hides no connection that really went silent.
			watch.sweep();
			Date.now = (): number => realNow() - 60_000;
			watch.sweep();
		} finally {
			Date.now = realNow;
		}
		expect(fresh.abortedWith).toBeUndefined();
		expect(silent.abortedWith?.message).toContain('silent');
	});

	it('forgets a connection once it closes', () => {
		const watch = new ConnectionLiveness();
		const conn = new FakeConnection();
		watch.track(conn, 0);
		conn.close();
		expect(watch.sweep(10 * CONNECTION_SILENCE_LIMIT_MS)).toBe(0);
		expect(conn.abortedWith).toBeUndefined();
	});

	it('watches every connection the libp2p upgrader reports to the metrics', () => {
		const watch = new ConnectionLiveness();
		const reported: unknown[] = [];
		const factory = withConnectionLiveness((_components: unknown) => ({ trackMultiaddrConnection: (maConn: unknown): number => reported.push(maConn) }), watch);
		const conn = new FakeConnection();
		factory({}).trackMultiaddrConnection(conn);
		expect(reported).toEqual([conn]);
		expect(watch.sweep(performance.now() + CONNECTION_SILENCE_LIMIT_MS)).toBe(1);
	});
});
