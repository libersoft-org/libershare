import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { networkInterfaces } from 'os';

let _isContainer: boolean | null = null;

export async function isContainer(): Promise<boolean> {
	if (_isContainer !== null) return _isContainer;
	_isContainer = await detect();
	return _isContainer;
}

async function detect(): Promise<boolean> {
	if (existsSync('/.dockerenv')) return true;
	try {
		const cgroup = await readFile('/proc/self/cgroup', 'utf8');
		if (/docker|kubepods|containerd|lxc/i.test(cgroup)) return true;
	} catch {}
	try {
		const mountinfo = await readFile('/proc/self/mountinfo', 'utf8');
		if (/\/docker\/containers\//i.test(mountinfo)) return true;
	} catch {}
	return false;
}

export function getLocalAddresses(): Set<string> {
	const addresses = new Set<string>(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
	const ifaces = networkInterfaces();
	for (const entries of Object.values(ifaces)) {
		if (!entries) continue;
		for (const entry of entries) {
			addresses.add(entry.address);
			if (entry.family === 'IPv4') addresses.add(`::ffff:${entry.address}`);
		}
	}
	return addresses;
}
