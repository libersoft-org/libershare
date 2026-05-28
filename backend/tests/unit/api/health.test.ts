import { describe, expect, it } from 'bun:test';
import { handleHealthProbe } from '../../../src/api/api.ts';

describe('handleHealthProbe', () => {
	it('returns 200 with plain text body for /health', async () => {
		const res = handleHealthProbe(new Request('http://localhost:1158/health'));
		expect(res).not.toBeNull();
		expect(res!.status).toBe(200);
		expect(res!.headers.get('content-type')).toContain('text/plain');
		expect(await res!.text()).toBe('ok\n');
	});

	it('returns null for the WebSocket-upgrade path', () => {
		expect(handleHealthProbe(new Request('http://localhost:1158/'))).toBeNull();
	});

	it('returns null for arbitrary paths', () => {
		expect(handleHealthProbe(new Request('http://localhost:1158/api/method'))).toBeNull();
		expect(handleHealthProbe(new Request('http://localhost:1158/healthcheck'))).toBeNull();
		expect(handleHealthProbe(new Request('http://localhost:1158/HEALTH'))).toBeNull();
	});

	it('matches exact path even with query string', async () => {
		const res = handleHealthProbe(new Request('http://localhost:1158/health?probe=1'));
		expect(res).not.toBeNull();
		expect(res!.status).toBe(200);
	});

	it('does not match nested paths', () => {
		expect(handleHealthProbe(new Request('http://localhost:1158/health/extra'))).toBeNull();
	});
});
