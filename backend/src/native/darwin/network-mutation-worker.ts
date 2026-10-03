import { validateIPv4Config, type NetIPv4Config } from '@shared';
import { DarwinNetworkSession } from './network-framework.ts';
import { darwinIPv4Mode, darwinIPv4Addresses } from './network-reader.ts';
import { readDarwinKernelNetwork } from './routes.ts';
import { usableDarwinAddress, type DarwinIPv4Recovery } from './network-mutation-state.ts';
import type { CFRef } from './cf.ts';

export interface DarwinIPv4Prepare {
	readonly device: string;
	readonly desired: NetIPv4Config;
	readonly addressingChanged: boolean;
	readonly requireLease: boolean;
}
export interface DarwinIPv4Write { readonly token: string; readonly restore: boolean }
export type DarwinIPv4WriteResult = { readonly ok: true } | { readonly ok: false; readonly commitAttempted: boolean; readonly error: string };
interface Prepared {
	token: string;
	session: DarwinNetworkSession;
	ipv4: CFRef;
	dns: CFRef;
	original: { ipv4: CFRef; dns: CFRef };
	target: { ipv4: CFRef; dns: CFRef };
	recovery: DarwinIPv4Recovery;
}

function mask(prefix: number): string {
	const value = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
	return [24, 16, 8, 0].map(shift => (value >>> shift) & 255).join('.');
}

/** The preferences lock and CF snapshots remain on one worker until release. */
export class DarwinNetworkMutationWorker {
	private prepared: Prepared | undefined;
	prepare(request: DarwinIPv4Prepare): { token: string; recovery: DarwinIPv4Recovery } {
		if (this.prepared) throw new Error('A macOS preferences transaction is already open');
		if (!/^[A-Za-z0-9._-]{1,64}$/.test(request.device) || validateIPv4Config(request.desired, { staticGatewayRequired: true })) throw new Error('Invalid macOS IPv4 request');
		const session = new DarwinNetworkSession();
		try {
			session.lock();
			const kernel = readDarwinKernelNetwork(), iface = kernel.interfaces.find(iface => iface.device === request.device);
			const bindings = session.services().filter(service => service.enabled && service.device === request.device);
			if (!iface || !iface.index || bindings.length !== 1) throw new Error('The device does not have exactly one enabled network service');
			if (kernel.routes.filter(route => route.family === 'ipv4' && route.device === request.device).length > 1) throw new Error('The device has multiple default routes');
			const service = bindings[0]!, mode = darwinIPv4Mode(service.ipv4);
			if (mode === 'unknown' || (mode === 'static' && darwinIPv4Addresses(service.ipv4).length !== 1)) throw new Error('The original IPv4 policy cannot be preserved safely');
			const ipv4 = session.protocol(service.ref, 'IPv4'), dns = session.protocol(service.ref, 'DNS');
			if (!ipv4 || (!dns && request.desired.dns !== undefined)) throw new Error('The network service lacks a required protocol');
			const cf = session.cf;
			const original = { ipv4: cf.deepCopy(session.sc.SCNetworkProtocolGetConfiguration(ipv4)), dns: dns ? cf.deepCopy(session.sc.SCNetworkProtocolGetConfiguration(dns)) : 0n };
			const target = { ipv4: cf.deepCopy(original.ipv4, true), dns: cf.deepCopy(original.dns, true) };
			if (request.addressingChanged) {
				if (!target.ipv4) target.ipv4 = cf.fromJS({});
				cf.set(target.ipv4, 'ConfigMethod', request.desired.mode === 'dhcp' ? 'DHCP' : 'Manual');
				if (request.desired.mode === 'dhcp') for (const key of ['Addresses', 'SubnetMasks', 'Router']) cf.remove(target.ipv4, key);
				else { cf.set(target.ipv4, 'Addresses', [request.desired.address!]); cf.set(target.ipv4, 'SubnetMasks', [mask(request.desired.prefixLength!)]); cf.set(target.ipv4, 'Router', request.desired.gateway!); }
			}
			if (request.desired.dns !== undefined) {
				if (!target.dns) target.dns = cf.fromJS({});
				if (request.desired.dns.length) cf.set(target.dns, 'ServerAddresses', request.desired.dns);
				else {
					cf.remove(target.dns, 'ServerAddresses');
					if (Number(cf.symbols.CFDictionaryGetCount(target.dns)) === 0) target.dns = 0n;
				}
			}
			const recovery: DarwinIPv4Recovery = { device: request.device, serviceId: service.id, interfaceIndex: iface.index, mac: iface.mac, original: { ipv4: cf.serialize(original.ipv4), dns: cf.serialize(original.dns), hadLease: iface.addresses.some(address => address.family === 'ipv4' && usableDarwinAddress(address.address)), linkActive: session.value(`State:/Network/Interface/${request.device}/Link`)?.['Active'] === true }, target: { ipv4: cf.serialize(target.ipv4), dns: cf.serialize(target.dns) }, desired: request.desired, addressingChanged: request.addressingChanged, requireLease: request.requireLease };
			const token = crypto.randomUUID();
			this.prepared = { token, session, ipv4, dns, original, target, recovery };
			return { token, recovery };
		} catch (error) { session.close(); throw error; }
	}
	write(request: DarwinIPv4Write): DarwinIPv4WriteResult {
		const prepared = this.prepared;
		if (!prepared || prepared.token !== request.token) return { ok: false, commitAttempted: false, error: 'The macOS preferences transaction is unavailable' };
		const { session, recovery } = prepared;
		let commitAttempted = false;
		try {
			const iface = readDarwinKernelNetwork().interfaces.find(iface => iface.device === recovery.device);
			if (!iface || iface.index !== recovery.interfaceIndex || iface.mac !== recovery.mac) throw new Error('The interface identity changed');
			const values = request.restore ? prepared.original : prepared.target;
			if (recovery.addressingChanged && !session.sc.SCNetworkProtocolSetConfiguration(prepared.ipv4, values.ipv4)) throw session.error('Set IPv4 configuration');
			if (recovery.desired.dns !== undefined && !session.sc.SCNetworkProtocolSetConfiguration(prepared.dns, values.dns)) throw session.error('Set DNS configuration');
			commitAttempted = true;
			if (!session.sc.SCPreferencesCommitChanges(session.preferences)) throw session.error('SCPreferencesCommitChanges');
			if (!session.sc.SCPreferencesApplyChanges(session.preferences)) throw session.error('SCPreferencesApplyChanges');
			return { ok: true };
		} catch (error) { return { ok: false, commitAttempted, error: error instanceof Error ? error.message : String(error) }; }
	}
	release(token: string): void {
		if (!this.prepared || this.prepared.token !== token) throw new Error('The macOS preferences transaction is unavailable');
		const session = this.prepared.session;
		this.prepared = undefined;
		session.close();
	}
	close(): void { if (this.prepared) this.release(this.prepared.token); }
}
