import { describe, it, expect } from 'bun:test';
import { formatParamsForLog } from '../../../src/api/api.ts';

describe('formatParamsForLog', () => {
	it('leaves a small params object intact', () => {
		expect(formatParamsForLog({ path: '/tmp/a.lish' })).toBe('{"path":"/tmp/a.lish"}');
	});

	it('truncates a file-sized base64 upload instead of logging all of it', () => {
		const line = formatParamsForLog({ data: 'A'.repeat(2 * 1024 * 1024), fileName: 'a.lish.gz' });
		expect(line.length).toBeLessThan(1100);
		expect(line).toContain('chars)');
	});

	it('renders missing params instead of the empty string', () => {
		expect(formatParamsForLog(undefined)).toBe('undefined');
	});
});
