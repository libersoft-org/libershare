export function checkNativeRuntime(version: string, target?: string, platform: string = process.platform, architecture: string = process.arch): void {
	const windowsArm64 = target ? target === 'bun-windows-arm64' || target === 'bun-windows-aarch64' : platform === 'win32' && architecture === 'arm64';
	if (windowsArm64 && !Bun.semver.satisfies(version, '>=1.4.0')) throw new Error('Windows ARM64 requires Bun 1.4.0 or newer; older releases disable bun:ffi.');
}

if (import.meta.main) checkNativeRuntime(Bun.version, process.argv[2] || undefined);
