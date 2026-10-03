import { describe, expect, test } from 'bun:test';
import { CoreFoundation } from '../../src/native/darwin/cf.ts';

describe.skipIf(process.platform !== 'darwin')('CoreFoundation ownership and lossless snapshots', () => {
	test('round-trips Unicode, embedded NULs and strings beyond 4 KiB', () => {
		const cf = new CoreFoundation();
		try {
			for (const value of ['', 'žluťoučký 🦆', 'before\0after', '界'.repeat(12000)]) expect(cf.toJS(cf.createString(value))).toBe(value);
		} finally { cf.close(); }
	});
	test('preserves integers, real numbers, booleans, binary data and dates across a binary plist', () => {
		const cf = new CoreFoundation();
		try {
			const value = { Enabled: true, Disabled: false, Count: 42, Large: 9007199254740993n, Ratio: 1.25, Bytes: Buffer.from([0, 255, 128]), Created: new Date('2026-01-01T12:00:00Z'), Names: ['one', 'two'] };
			const ref = cf.fromJS(value), encoded = cf.serialize(ref), restored = cf.deserialize(encoded);
			expect(cf.symbols.CFEqual(ref, restored)).toBe(true);
			expect(cf.toJS(restored)).toEqual(value);
		} finally { cf.close(); }
	});
	test('deep copies do not follow later changes and mutable copies preserve unknown keys', () => {
		const cf = new CoreFoundation();
		try {
			const original = cf.fromJS({ ServerAddresses: ['192.0.2.53'], SearchOrder: 200, Unknown: { Flag: true, Bytes: Buffer.from([1, 2]) } });
			const snapshot = cf.deepCopy(original), target = cf.deepCopy(original, true);
			cf.set(target, 'ServerAddresses', ['198.51.100.53']); cf.remove(target, 'SearchOrder');
			expect(cf.symbols.CFEqual(original, snapshot)).toBe(true);
			expect(cf.symbols.CFEqual(original, target)).toBe(false);
			expect(cf.toJS(target)).toEqual({ ServerAddresses: ['198.51.100.53'], Unknown: { Flag: true, Bytes: Buffer.from([1, 2]) } });
		} finally { cf.close(); }
	});
	test('duplicate tagged references have balanced ownership and close is idempotent', () => {
		const cf = new CoreFoundation();
		const a = cf.createString('short'), b = cf.createString('short');
		cf.release(a);
		expect(cf.string(b)).toBe('short');
		cf.close(); cf.close();
	});
});
