import { expect, test } from 'bun:test';
import { join } from 'node:path';

async function runPath(mode: 'read' | 'apply' | 'ovs' | 'ovs-incomplete'): Promise<any> {
	const script = String.raw`
		import { mock } from 'bun:test';
		const cp = { ...(await import('node:child_process')) };
		const fs = { ...(await import('node:fs')) };
		const calls = [];
		const mode = ${JSON.stringify(mode)};
		const withOvs = mode.startsWith('ovs');
		const profiles = Array.from({ length: withOvs ? 2 : 150 }, (_, i) => ({ id: '00000000-0000-4000-8000-' + i.toString(16).padStart(12, '0'), device: withOvs && i === 1 ? 'ovs0' : 'eth' + i }));
		const devices = profiles.slice(0, withOvs ? 2 : 1);
		function detail(p) {
			const ovs = p.device === 'ovs0';
			return [
				'connection.uuid:' + p.id, 'connection.type:' + (ovs ? 'ovs-bridge' : '802-3-ethernet'), 'connection.master:', 'connection.slave-type:',
				'connection.interface-name:' + p.device, ...(mode !== 'apply' ? ['connection.multi-connect:0'] : []),
				...(ovs ? [] : [
				'ipv4.method:auto', 'ipv4.never-default:no', 'ipv4.gateway:', 'ipv4.addresses:',
				'ipv4.routes:', 'ipv4.route-table:0', ...(mode === 'ovs-incomplete' ? [] : ['ipv4.routing-rules:']),
				]),
			].join('\n');
		}
		mock.module('node:fs', () => ({ ...fs,
			existsSync: path => String(path).startsWith('/sys/') ? false : fs.existsSync(path),
			readFileSync: (path, ...args) => String(path).startsWith('/proc/') || path === '/etc/resolv.conf' ? '' : fs.readFileSync(path, ...args),
		}));
		const execFile = (bin, args, options, callback) => {
			const done = typeof options === 'function' ? options : callback;
			calls.push({ bin, args });
			let stdout;
			if (bin.endsWith('/ip') || bin === 'ip') stdout = args.includes('addr') ? JSON.stringify(devices.map((p, i) => ({ ifindex: i + 1, ifname: p.device, addr_info: [] }))) : args.includes('link') ? JSON.stringify(devices.map((p, i) => ({ ifindex: i + 1, ifname: p.device, link_type: 'ether', operstate: 'UP', flags: ['UP'] }))) : '[]';
			else if (args.includes('UUID,DEVICE')) stdout = profiles.map(p => p.id + ':' + p.device).join('\n');
			else if (args.includes('multiline')) stdout = profiles.filter(p => args.includes(p.id)).map(detail).join('\n\n');
			else if (args.includes('GENERAL.DEVICE,GENERAL.NM-MANAGED,IP4.DNS,IP6.DNS')) stdout = devices.map(p => 'GENERAL.DEVICE:' + p.device + '\nGENERAL.NM-MANAGED:yes').join('\n');
			else if (args.includes('GENERAL.DBUS-PATH')) stdout = '/org/freedesktop/NetworkManager/Devices/1';
			else if (args.includes('CheckpointCreate')) stdout = 'o "/org/freedesktop/NetworkManager/Checkpoint/1"';
			else if (args.includes('CheckpointRollback')) stdout = 'a{su} 1 "/org/freedesktop/NetworkManager/Devices/1" 0';
			else return done(new Error('unexpected OS command: ' + args.join(' ')));
			done(null, { stdout, stderr: '' });
		};
		mock.module('node:child_process', () => ({ ...cp, execFile }));
		const { readLinuxNetworkState, applyLinuxIPv4 } = await import('./src/system-network-linux.ts');
		const result = mode !== 'apply' ? await readLinuxNetworkState() : await applyLinuxIPv4('eth0', { mode: 'dhcp' }).then(() => 'applied', e => ({ name: e.name, message: e.message }));
		console.log(JSON.stringify({ result, calls }));
	`;
	const child = Bun.spawn([process.execPath, '--eval', script], { cwd: join(import.meta.dir, '../..'), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
	const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
	if (code !== 0) throw new Error(err);
	const lines = out.trim().split('\n');
	return JSON.parse(lines[lines.length - 1]!);
}

test('the production Linux reader obtains 150 profiles with one listing and one detail process', async () => {
	const { result, calls } = await runPath('read');
	expect(result.ipv4ProfilesUnavailable).toBe(false);
	expect(result.interfaces[0]).toMatchObject({ id: 'eth0', ipv4Mode: 'dhcp', ipv4Configurable: true });
	expect(calls.filter((call: any) => call.args.includes('UUID,DEVICE'))).toHaveLength(1);
	const detail = calls.filter((call: any) => call.args.includes('multiline'));
	expect(detail).toHaveLength(1);
	expect(detail[0].args.filter((arg: string) => arg === 'uuid')).toHaveLength(150);
});

test('the production IPv4 mutation refuses incomplete profile details before modify or reapply', async () => {
	const { result, calls } = await runPath('apply');
	expect(result.name).toBe('IncompleteProfileReadError');
	expect(result.message).toContain('connection.multi-connect');
	expect(calls.some((call: any) => call.args.includes('modify') || call.args.includes('reapply') || call.args.includes('up'))).toBe(false);
	expect(calls.some((call: any) => call.args.includes('CheckpointRollback'))).toBe(true);
	expect(calls.some((call: any) => call.args.includes('CheckpointDestroy'))).toBe(false);
});

test('an OVS bridge without IPv4 leaves the ordinary connection editable in the same batch', async () => {
	const { result, calls } = await runPath('ovs');
	expect(result.ipv4ProfilesUnavailable).toBe(false);
	expect(result.interfaces.find((iface: any) => iface.id === 'eth0')).toMatchObject({ ipv4Mode: 'dhcp', ipv4Configurable: true });
	expect(result.interfaces.find((iface: any) => iface.id === 'ovs0')).toMatchObject({ ipv4Mode: 'unknown', ipv4Configurable: false });
	const details = calls.filter((call: any) => call.args.includes('multiline'));
	expect(details).toHaveLength(1);
	expect(details[0].args.filter((arg: string) => arg === 'uuid')).toHaveLength(2);
});

test('an OVS bridge does not make an incomplete ordinary IPv4 profile acceptable', async () => {
	const { result } = await runPath('ovs-incomplete');
	expect(result.ipv4ProfilesUnavailable).toBe(true);
	expect(result.interfaces.find((iface: any) => iface.id === 'eth0').ipv4Configurable).toBe(false);
});
