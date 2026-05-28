import { describe, expect, it } from 'bun:test';
import { resolveHealthcheckPort } from '../../src/healthcheck.ts';

describe('resolveHealthcheckPort', () => {
	it('uses explicit --port when positive', () => {
		expect(resolveHealthcheckPort(2200, undefined)).toEqual({ port: 2200 });
	});

	it('explicit --port wins over BACKEND_PORT env', () => {
		expect(resolveHealthcheckPort(2200, '9999')).toEqual({ port: 2200 });
	});

	it('falls back to BACKEND_PORT when --port is unset', () => {
		const decision = resolveHealthcheckPort(0, '2200');
		expect(decision.port).toBe(2200);
		expect(decision.exit).toBeUndefined();
	});

	it('falls back to 1158 when neither --port nor BACKEND_PORT is set', () => {
		expect(resolveHealthcheckPort(0, undefined)).toEqual({ port: 1158 });
	});

	it('falls back to 1158 when BACKEND_PORT is empty string', () => {
		expect(resolveHealthcheckPort(0, '')).toEqual({ port: 1158 });
	});

	it('exits with code 2 when BACKEND_PORT is non-numeric', () => {
		const decision = resolveHealthcheckPort(0, 'abc');
		expect(decision.exit).toBe(2);
		expect(decision.message).toContain('BACKEND_PORT');
		expect(decision.message).toContain('"abc"');
	});

	it('exits with code 2 when BACKEND_PORT is zero', () => {
		const decision = resolveHealthcheckPort(0, '0');
		expect(decision.exit).toBe(2);
	});

	it('exits with code 2 when BACKEND_PORT is negative', () => {
		const decision = resolveHealthcheckPort(0, '-1');
		expect(decision.exit).toBe(2);
	});

	it('returns the parsed port even when --port=0', () => {
		// Random-port mode (--port 0) is allowed if the operator wires
		// BACKEND_PORT to point at the actual bound port.
		const decision = resolveHealthcheckPort(0, '54321');
		expect(decision.port).toBe(54321);
	});
});
