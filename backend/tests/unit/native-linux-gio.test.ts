import { expect, it } from 'bun:test';
import { displayEnvironment, openLinuxPath } from '../../src/native/linux/gio.ts';
it('only forwards activation display variables', () => {
	expect(displayEnvironment({ DISPLAY: ':1', WAYLAND_DISPLAY: 'wayland-0', XAUTHORITY: '/tmp/auth', SECRET: 'hidden' })).toEqual({ DISPLAY: ':1', WAYLAND_DISPLAY: 'wayland-0', XAUTHORITY: '/tmp/auth' });
});
it('rejects a headless launch and embedded NUL before loading native libraries', async () => {
	await expect(openLinuxPath({ path: '/tmp/test', environment: {}, timeoutMs: 10000 })).rejects.toThrow('graphical session');
	await expect(openLinuxPath({ path: '/tmp/test\0other', environment: { DISPLAY: ':1' }, timeoutMs: 10000 })).rejects.toThrow('Invalid local path');
});
