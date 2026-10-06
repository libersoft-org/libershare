import { expect, it } from 'bun:test';
import { displayEnvironment, openLinuxPath } from '../../src/native/linux/gio.ts';
it('only forwards activation display variables', () => {
	expect(displayEnvironment({ DISPLAY: ':1', WAYLAND_DISPLAY: 'wayland-0', XAUTHORITY: '/tmp/auth', SECRET: 'hidden' })).toEqual({ DISPLAY: ':1', WAYLAND_DISPLAY: 'wayland-0', XAUTHORITY: '/tmp/auth' });
});
it('rejects a headless launch and embedded NUL before loading native libraries', async () => {
	await expect(openLinuxPath({ path: '/tmp/test', environment: {}, timeoutMs: 10000 })).rejects.toThrow('graphical session');
	await expect(openLinuxPath({ path: '/tmp/test\0other', environment: { DISPLAY: ':1' }, timeoutMs: 10000 })).rejects.toThrow('Invalid local path');
});
it('opens the file through GIO when the user session bus is unavailable', async () => {
	const script = `
		import { mock } from 'bun:test';
		const dbus = await import('./src/native/linux/dbus.ts');
		const library = await import('./src/native/library.ts');
		const calls = [];
		mock.module('./src/native/linux/dbus.ts', () => ({ ...dbus, SystemBus: class { constructor() { calls.push('bus'); throw new Error('no user bus'); } } }));
		mock.module('./src/native/library.ts', () => ({ ...library, loadSystemLibrary: () => ({ close() {}, symbols: {
			g_file_new_for_path: () => 1, g_file_get_uri: () => 2, g_app_info_launch_default_for_uri: () => { calls.push('launch'); return true; },
			g_error_free: () => {}, g_free: () => {}, g_object_unref: () => {},
		} }) }));
		const { openLinuxPath } = await import('./src/native/linux/gio.ts');
		await openLinuxPath({ path: '/tmp/example.txt', environment: { DISPLAY: ':1' }, timeoutMs: 10000 });
		console.log(JSON.stringify(calls));
	`;
	const child = Bun.spawn([process.execPath, '--eval', script], { cwd: `${import.meta.dir}/../..`, stdout: 'pipe', stderr: 'pipe' });
	const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
	if (code !== 0) throw new Error(err);
	expect(JSON.parse(out.trim().split('\n').pop()!)).toEqual(['bus', 'launch']);
});
