import { CString, type Library } from 'bun:ffi';
import { loadSystemLibrary } from '../library.ts';
import { CoreFoundation, type CFRef, type CFValue } from './cf.ts';

export const SYSTEM_CONFIGURATION = '/System/Library/Frameworks/SystemConfiguration.framework/SystemConfiguration';
export type DarwinDictionary = { [key: string]: CFValue };
export interface DarwinService {
	readonly ref: CFRef;
	readonly id: string;
	readonly name: string;
	readonly device: string | null;
	readonly port: string | null;
	readonly type: string | null;
	readonly enabled: boolean;
	readonly ipv4: DarwinDictionary | null;
	readonly dns: DarwinDictionary | null;
}

const symbols = {
	SCDynamicStoreCreate: { args: ['u64', 'u64', 'ptr', 'ptr'], returns: 'u64' },
	SCDynamicStoreCopyValue: { args: ['u64', 'u64'], returns: 'u64' },
	SCDynamicStoreCopyKeyList: { args: ['u64', 'u64'], returns: 'u64' },
	SCPreferencesCreate: { args: ['u64', 'u64', 'u64'], returns: 'u64' },
	SCPreferencesPathGetValue: { args: ['u64', 'u64'], returns: 'u64' },
	SCPreferencesLock: { args: ['u64', 'bool'], returns: 'bool' },
	SCPreferencesCommitChanges: { args: ['u64'], returns: 'bool' },
	SCPreferencesApplyChanges: { args: ['u64'], returns: 'bool' },
	SCPreferencesUnlock: { args: ['u64'], returns: 'bool' },
	SCError: { args: [], returns: 'i32' }, SCErrorString: { args: ['i32'], returns: 'ptr' },
	SCNetworkSetCopyCurrent: { args: ['u64'], returns: 'u64' },
	SCNetworkSetCopyServices: { args: ['u64'], returns: 'u64' },
	SCNetworkSetGetServiceOrder: { args: ['u64'], returns: 'u64' },
	SCNetworkServiceCopy: { args: ['u64', 'u64'], returns: 'u64' },
	SCNetworkServiceGetName: { args: ['u64'], returns: 'u64' },
	SCNetworkServiceGetServiceID: { args: ['u64'], returns: 'u64' },
	SCNetworkServiceGetEnabled: { args: ['u64'], returns: 'bool' },
	SCNetworkServiceGetInterface: { args: ['u64'], returns: 'u64' },
	SCNetworkInterfaceCopyAll: { args: [], returns: 'u64' },
	SCNetworkInterfaceGetBSDName: { args: ['u64'], returns: 'u64' },
	SCNetworkInterfaceGetInterfaceType: { args: ['u64'], returns: 'u64' },
	SCNetworkInterfaceGetLocalizedDisplayName: { args: ['u64'], returns: 'u64' },
	SCNetworkServiceCopyProtocol: { args: ['u64', 'u64'], returns: 'u64' },
	SCNetworkProtocolGetConfiguration: { args: ['u64'], returns: 'u64' },
	SCNetworkProtocolSetConfiguration: { args: ['u64', 'u64'], returns: 'bool' },
} as const;

export function darwinDictionary(value: CFValue): DarwinDictionary | null {
	return value !== null && typeof value === 'object' && !Array.isArray(value) && !Buffer.isBuffer(value) && !(value instanceof Date) ? value : null;
}
export function darwinStrings(value: CFValue | undefined): string[] {
	return Array.isArray(value) && value.every(item => typeof item === 'string') ? value as string[] : [];
}

/** All borrowed service/protocol references stay inside this worker-local session. */
export class DarwinNetworkSession {
	readonly cf: CoreFoundation = new CoreFoundation();
	private readonly library: Library<typeof symbols>;
	readonly sc: Library<typeof symbols>['symbols'];
	readonly preferences: CFRef;
	readonly store: CFRef;
	private locked = false;
	private closed = false;
	constructor() {
		let library: Library<typeof symbols> | undefined;
		try {
			library = loadSystemLibrary(SYSTEM_CONFIGURATION, symbols);
			this.library = library;
			this.sc = library.symbols;
			const name = this.cf.createString('LiberShare network settings');
			this.preferences = this.cf.own(this.sc.SCPreferencesCreate(0n, name, 0n));
			this.store = this.cf.own(this.sc.SCDynamicStoreCreate(0n, name, null, null));
		} catch (error) { this.cf.close(); library?.close(); throw error; }
	}
	error(operation: string): Error {
		const code = this.sc.SCError(), message = this.sc.SCErrorString(code);
		return new Error(`${operation}: SCError ${code}${message ? ` ${new CString(message).toString()}` : ''}`);
	}
	lock(): void {
		if (!this.sc.SCPreferencesLock(this.preferences, true)) throw this.error('SCPreferencesLock');
		this.locked = true;
	}
	unlock(): void {
		if (!this.locked) return;
		if (!this.sc.SCPreferencesUnlock(this.preferences)) throw this.error('SCPreferencesUnlock');
		this.locked = false;
	}
	value(key: string): DarwinDictionary | null {
		const name = this.cf.createString(key);
		try {
			const value = this.sc.SCDynamicStoreCopyValue(this.store, name);
			if (!value) return null;
			this.cf.own(value);
			try { return darwinDictionary(this.cf.toJS(value)); } finally { this.cf.release(value); }
		} finally { this.cf.release(name); }
	}
	keys(pattern: string): string[] {
		const key = this.cf.createString(pattern);
		try {
			const array = this.sc.SCDynamicStoreCopyKeyList(this.store, key);
			if (!array) throw this.error('SCDynamicStoreCopyKeyList');
			this.cf.own(array);
			try { return this.cf.array(array).map(ref => this.cf.string(ref)); } finally { this.cf.release(array); }
		} finally { this.cf.release(key); }
	}
	protocol(service: CFRef, type: 'IPv4' | 'DNS'): CFRef {
		const name = this.cf.createString(type);
		try { const ref = this.sc.SCNetworkServiceCopyProtocol(service, name); return ref ? this.cf.own(ref) : 0n; }
		finally { this.cf.release(name); }
	}
	configuration(protocol: CFRef): DarwinDictionary | null { return protocol ? darwinDictionary(this.cf.toJS(this.sc.SCNetworkProtocolGetConfiguration(protocol))) : null; }
	services(): DarwinService[] {
		const current = this.sc.SCNetworkSetCopyCurrent(this.preferences);
		if (!current) throw this.error('SCNetworkSetCopyCurrent');
		this.cf.own(current);
		const orderRef = this.sc.SCNetworkSetGetServiceOrder(current);
		const order = orderRef ? this.cf.array(orderRef).map(ref => this.cf.string(ref)) : [];
		const all = this.sc.SCNetworkSetCopyServices(current);
		if (!all) throw this.error('SCNetworkSetCopyServices');
		this.cf.own(all);
		const string = (ref: CFRef): string | null => ref ? this.cf.string(ref) : null;
		const visible = this.cf.array(all).filter(ref => {
			const id = this.cf.string(this.sc.SCNetworkServiceGetServiceID(ref));
			const path = this.cf.createString(`/NetworkServices/${id}/Interface`);
			try { return darwinDictionary(this.cf.toJS(this.sc.SCPreferencesPathGetValue(this.preferences, path)))?.['HiddenConfiguration'] !== true; }
			finally { this.cf.release(path); }
		});
		const services = visible.map(ref => {
			const iface = this.sc.SCNetworkServiceGetInterface(ref), id = this.cf.string(this.sc.SCNetworkServiceGetServiceID(ref));
			return { ref, id, name: string(this.sc.SCNetworkServiceGetName(ref)) ?? id, enabled: this.sc.SCNetworkServiceGetEnabled(ref), device: iface ? string(this.sc.SCNetworkInterfaceGetBSDName(iface)) : null, port: iface ? string(this.sc.SCNetworkInterfaceGetLocalizedDisplayName(iface)) : null, type: iface ? string(this.sc.SCNetworkInterfaceGetInterfaceType(iface)) : null, ipv4: this.configuration(this.protocol(ref, 'IPv4')), dns: this.configuration(this.protocol(ref, 'DNS')) };
		});
		// networksetup excludes HiddenConfiguration interfaces and follows the current set order.
		return services.filter(service => order.includes(service.id)).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
	}
	ports(): Map<string, { name: string; type: string }> {
		const all = this.cf.own(this.sc.SCNetworkInterfaceCopyAll());
		const result = new Map<string, { name: string; type: string }>();
		for (const ref of this.cf.array(all)) {
			const name = this.sc.SCNetworkInterfaceGetBSDName(ref), label = this.sc.SCNetworkInterfaceGetLocalizedDisplayName(ref), type = this.sc.SCNetworkInterfaceGetInterfaceType(ref);
			if (name && label && type) result.set(this.cf.string(name), { name: this.cf.string(label), type: this.cf.string(type) });
		}
		return result;
	}
	close(): void {
		if (this.closed) return;
		this.closed = true;
		try { this.unlock(); } finally { this.cf.close(); this.library.close(); }
	}
}
