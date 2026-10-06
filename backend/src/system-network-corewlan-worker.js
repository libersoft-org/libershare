import { ptr, read, toArrayBuffer } from 'bun:ffi';
import { ObjectiveC } from './native/darwin/objc.ts';
import { isMainThread } from 'node:worker_threads';
import { coreWlanAssociationMatches, coreWlanDisconnected, coreWlanInterfaceState, coreWlanNamesVisible, coreWlanScanRows, coreWlanSecurityType, selectCoreWlanTarget } from './system-network-corewlan-rows.js';

export { coreWlanAssociationMatches, coreWlanDisconnected, coreWlanInterfaceState, coreWlanNamesVisible, coreWlanScanRows, coreWlanSecurityType, selectCoreWlanTarget };

/** Last proven name access per interface; the pooled reader keeps it between reads. */
const namesVisible = new Map();

/** Shared phase: preparing 0 -> mutating 1 competes atomically with parent cancellation 2. */
export function beginCoreWlanMutation(phase) {
	if (Atomics.compareExchange(phase, 0, 0, 1) !== 0) throw new Error('macOS Wi-Fi operation was cancelled before the network change');
}

export function disconnectCoreWlanInterface(phase, disconnect, snapshot) {
	if (snapshot().interfaceMode !== 1) throw new Error('macOS Wi-Fi interface is not connected as a station');
	beginCoreWlanMutation(phase);
	disconnect();
	// CoreWLAN has a void disconnect API; allow five seconds for the radio state to settle.
	for (let attempt = 0; attempt < 50; attempt++) {
		if (Atomics.load(phase, 0) !== 1) throw new Error('macOS Wi-Fi disconnect verification was cancelled');
		if (coreWlanDisconnected(snapshot())) return;
		Atomics.wait(phase, 0, 1, 100);
	}
	throw new Error('macOS did not confirm Wi-Fi disconnection');
}

function run(request) {
	if (process.platform !== 'darwin') throw new Error('CoreWLAN is only available on macOS');
	const objc = new ObjectiveC('CoreWLAN');
	const calls = objc.calls;
	const buffers = objc.buffers;
	const selector = name => objc.selector(name);
	const klass = name => objc.klass(name);
	const string = value => objc.string(value);
	const get = (object, name) => objc.get(BigInt(object), name);
	const integer = (object, name) => objc.integer(BigInt(object), name);
	const flag = (object, name) => objc.flag(BigInt(object), name);
	const text = object => objc.text(BigInt(object));

	const errorBuffer = new BigUint64Array(1);
	const nativeError = operation => {
		const error = read.ptr(ptr(errorBuffer));
		return new Error(`macOS Wi-Fi ${operation} failed${error ? ` (CoreWLAN error ${integer(error, 'code')})` : ''}`);
	};
	const bytes = data => {
		if (!data) return null;
		const length = integer(data, 'length');
		const address = get(data, 'bytes');
		return address && length > 0 ? Buffer.from(toArrayBuffer(Number(address), 0, length)) : null;
	};
	const snapshot = iface => ({
		device: text(get(iface, 'interfaceName')),
		interfaceMode: integer(iface, 'interfaceMode'),
		ssidHex: bytes(get(iface, 'ssidData'))?.toString('hex') ?? null,
		bssid: text(get(iface, 'bssid'))?.toLowerCase() ?? null,
		securityType: integer(iface, 'security'),
		signal: integer(iface, 'rssiValue'),
		powerOn: flag(iface, 'powerOn'),
	});
	const scan = (iface, ssidHex = null) => {
		let ssidData = 0n;
		if (ssidHex !== null) {
			const expected = Buffer.from(ssidHex, 'hex');
			buffers.push(expected);
			ssidData = calls.symbols.data(klass('NSData'), selector('dataWithBytes:length:'), ptr(expected), BigInt(expected.length));
		}
		errorBuffer[0] = 0n;
		const networks = calls.symbols.scan(iface, selector('scanForNetworksWithSSID:error:'), ssidData, ptr(errorBuffer));
		if (!networks) throw nativeError('scan');
		const iterator = get(networks, 'objectEnumerator');
		const result = [];
		for (let network = get(iterator, 'nextObject'); network; network = get(iterator, 'nextObject')) {
			const supports = type => calls.symbols.supports(network, selector('supportsSecurity:'), BigInt(type));
			result.push({
				network,
				ssidHex: bytes(get(network, 'ssidData'))?.toString('hex') ?? null,
				bssid: text(get(network, 'bssid'))?.toLowerCase() ?? null,
				securityType: coreWlanSecurityType([0, 1, 2, 4, 6, 7, 9, 11, 12, 14, 15].filter(supports)),
				signal: integer(network, 'rssiValue'),
			});
		}
		return result;
	};
	try {
		const client = get(klass('CWWiFiClient'), 'sharedWiFiClient');
		if (request.operation === 'state') {
			const interfaces = get(client, 'interfaces');
			const result = [];
			for (let index = 0; index < integer(interfaces, 'count'); index++) {
				const iface = calls.symbols.objectArg(interfaces, selector('objectAtIndex:'), BigInt(index));
				let current = snapshot(iface);
				let networks = [];
				if (current.powerOn && !current.ssidHex) {
					try {
						networks = scan(iface);
						current = snapshot(iface);
					} catch {
						// A refused scan leaves name access unknown; the radio state is still valid.
					}
				}
				if (!current.device) continue;
				const visible = coreWlanNamesVisible(current, networks, namesVisible.get(current.device));
				namesVisible.set(current.device, visible);
				result.push(coreWlanInterfaceState(current, visible));
			}
			return result;
		}
		const iface = calls.symbols.objectArg(client, selector('interfaceWithName:'), string(request.device));
		if (!iface) throw new Error('macOS Wi-Fi interface is unavailable');
		if (!flag(iface, 'powerOn')) throw new Error('macOS Wi-Fi radio is off');
		if (request.operation === 'scan') {
			const networks = scan(iface);
			if (networks.length && !networks.some(network => network.ssidHex)) throw new Error('macOS did not expose Wi-Fi network names');
			return coreWlanScanRows(networks, snapshot(iface));
		}
		if (request.operation === 'disconnect') {
			const method = selector('disassociate');
			return disconnectCoreWlanInterface(
				request.phase,
				() => calls.symbols.disconnect(iface, method),
				() => snapshot(iface)
			);
		}
		if (request.operation !== 'associate') throw new Error('Unsupported macOS Wi-Fi operation');
		const { ssidHex, bssid, password, securityType } = request;
		const candidates = scan(iface, ssidHex);
		const network = selectCoreWlanTarget(candidates, ssidHex, securityType, bssid);
		if (snapshot(iface).ssidHex === ssidHex) throw new Error('macOS is already connected to that Wi-Fi network');
		// The selected CWNetwork retains its BSSID. Never issue a name-only join.
		errorBuffer[0] = 0n;
		const method = selector('associateToNetwork:password:error:');
		const key = securityType === 0 ? 0n : string(password);
		beginCoreWlanMutation(request.phase);
		if (!calls.symbols.join(iface, method, network, key, ptr(errorBuffer))) throw nativeError('association');
		const actual = snapshot(iface);
		const selected = candidates.find(candidate => candidate.network === network);
		if (!coreWlanAssociationMatches(actual, ssidHex, selected.bssid, securityType)) throw new Error('macOS did not connect to the requested Wi-Fi network with the requested security');
	} finally {
		objc.close();
	}
}

if (!isMainThread)
	self.onmessage = event => {
		if (event.data.operation === 'close') {
			self.postMessage({ closed: true });
			return;
		}
		let response;
		try {
			response = { result: run(event.data) };
		} catch (error) {
			const password = event.data.password;
			const message = error instanceof Error ? error.message : 'macOS Wi-Fi operation failed';
			response = { error: password ? message.split(password).join('[redacted]') : message };
		} finally {
			event.data.password = '';
		}
		self.postMessage({ ...response, settled: true });
	};
