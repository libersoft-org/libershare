import { expect, test } from 'bun:test';
import { checkNativeRuntime } from '../../scripts/check-native-runtime.ts';

test('rejects a Windows ARM64 build whose bundled Bun cannot call native libraries', () => {
	expect(() => checkNativeRuntime('1.3.13', 'bun-windows-arm64', 'linux', 'x64')).toThrow('Bun 1.4.0');
	expect(() => checkNativeRuntime('1.3.13', undefined, 'win32', 'arm64')).toThrow('Bun 1.4.0');
	expect(() => checkNativeRuntime('1.4.0-canary.1', 'bun-windows-arm64')).toThrow('Bun 1.4.0');
});

test('accepts the first verified Windows ARM64 runtime and newer stable releases', () => {
	for (const version of ['1.4.0', '1.4.2']) {
		expect(() => checkNativeRuntime(version, 'bun-windows-arm64', 'linux', 'x64')).not.toThrow();
		expect(() => checkNativeRuntime(version, undefined, 'win32', 'arm64')).not.toThrow();
	}
});

test('preserves the existing runtime baseline for other build targets', () => {
	for (const target of ['bun-windows-x64', 'bun-linux-arm64', 'bun-darwin-arm64']) expect(() => checkNativeRuntime('1.3.13', target)).not.toThrow();
	expect(() => checkNativeRuntime('1.3.13', undefined, 'win32', 'x64')).not.toThrow();
});
