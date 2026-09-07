// Plain JavaScript: Bun copies file assets into compiled binaries without transpiling imports.
import { CString, dlopen, linkSymbols, FFIType, ptr, read, toArrayBuffer } from 'bun:ffi';
import { isMainThread } from 'node:worker_threads';

/** Mixed CoreWLAN enums also match a single constituent; inspect WPA versions individually. */
export function coreWlanSecurityType(supported) {
	if ([1, 6, 7, 9, 12, 14, 15].some(type => supported.includes(type))) return -1;
	if (supported.includes(11)) return supported.includes(4) ? 13 : 11;
	if (supported.includes(4)) return supported.includes(2) ? 3 : 4;
	if (supported.includes(2)) return 2;
	return supported.includes(0) ? 0 : -1;
}

/** Reject every ambiguous scan before choosing the strongest access point of the requested network. */
export function selectCoreWlanTarget(networks, ssidHex, securityType, bssid = null) {
	const targets = bssid === null ? networks : networks.filter(network => network.bssid?.toLowerCase() === bssid.toLowerCase());
	if (!targets.length) throw new Error('macOS Wi-Fi network is no longer available');
	if (bssid !== null && targets.length !== 1) throw new Error('macOS Wi-Fi access point identity is ambiguous');
	for (const network of targets) {
		if (network.ssidHex !== ssidHex) throw new Error('macOS cannot identify the requested Wi-Fi network');
		if (network.securityType !== securityType) throw new Error('macOS Wi-Fi security changed or the network name is ambiguous');
	}
	return targets.reduce((best, item) => (item.signal > best.signal ? item : best)).network;
}

/** CoreWLAN's returned bytes prove access in this bundle; helper CoreLocation status can describe a different identity. */
export function coreWlanNamesVisible(current, networks = []) {
	return current.powerOn && (!!current.ssidHex || networks.some(network => !!network.ssidHex));
}

/** Mixed scan modes permit either secured constituent, never a downgrade to open. */
export function coreWlanAssociationMatches(actual, ssidHex, bssid, securityType) {
	const allowed = securityType === 3 ? [2, 3, 4] : securityType === 13 ? [4, 11, 13] : [securityType];
	return actual.ssidHex === ssidHex && (bssid === null || actual.bssid === bssid) && allowed.includes(actual.securityType);
}

const SECURITY_LABELS = { 0: '', 2: 'WPA Personal', 3: 'WPA/WPA2 Personal', 4: 'WPA2 Personal', 11: 'WPA3 Personal', 13: 'WPA2/WPA3 Personal' };

/** Shared phase: preparing 0 -> associating 1 competes atomically with parent cancellation 2. */
export function beginCoreWlanAssociation(phase) {
	if (Atomics.compareExchange(phase, 0, 0, 1) !== 0) throw new Error('macOS Wi-Fi operation was cancelled before association');
}

function signalQuality(rssi) {
	return rssi === 0 ? null : Math.max(0, Math.min(100, 2 * (rssi + 100)));
}

export function coreWlanInterfaceState(snapshot, namesVisible) {
	return {
		device: snapshot.device,
		configurable: namesVisible && snapshot.powerOn,
		wifi: {
			ssid: namesVisible && snapshot.powerOn && snapshot.ssidHex ? Buffer.from(snapshot.ssidHex, 'hex').toString('utf8') : null,
			signal: snapshot.powerOn ? signalQuality(snapshot.signal) : null,
			radio: snapshot.powerOn ? 'on' : 'off',
		},
	};
}

/** Retain raw identities and never offer a join that the current-SSID guard must reject. */
export function coreWlanScanRows(networks, current) {
	return networks
		.filter(network => network.ssidHex)
		.map(network => {
			const ssid = Buffer.from(network.ssidHex, 'hex').toString('utf8');
			const alreadyJoined = network.ssidHex === current.ssidHex;
			const active = network.bssid === current.bssid && coreWlanAssociationMatches(current, network.ssidHex, network.bssid, network.securityType);
			const unsupportedName = ssid.includes('\0');
			return {
				ssid,
				ssidHex: network.ssidHex,
				bssid: network.bssid,
				signal: signalQuality(network.signal),
				secured: network.securityType !== 0,
				security: SECURITY_LABELS[network.securityType] ?? 'Unsupported',
				supported: network.securityType >= 0,
				connectable: !alreadyJoined && !unsupportedName,
				...(alreadyJoined ? { unavailableReason: 'This interface is already connected to this SSID' } : unsupportedName ? { unavailableReason: 'This SSID contains a NUL character and cannot be selected' } : {}),
				active,
			};
		})
		.sort((left, right) => (right.signal ?? -1) - (left.signal ?? -1));
}

function run(request) {
	if (process.platform !== 'darwin') throw new Error('CoreWLAN is only available on macOS');
	const objc = dlopen('/usr/lib/libobjc.A.dylib', {
		objc_getClass: { args: [FFIType.ptr], returns: FFIType.ptr },
		sel_registerName: { args: [FFIType.ptr], returns: FFIType.ptr },
		objc_autoreleasePoolPush: { args: [], returns: FFIType.ptr },
		objc_autoreleasePoolPop: { args: [FFIType.ptr], returns: FFIType.void },
	});
	// Tagged NSString pointers use all 64 bits; bun:ffi pointer Numbers would truncate them.
	// Objective-C objects cross the FFI boundary as u64 BigInts, with method-specific returns.
	const loader = dlopen('/usr/lib/libSystem.B.dylib', {
		dlopen: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.ptr },
		dlsym: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
		dlclose: { args: [FFIType.ptr], returns: FFIType.i32 },
	});
	const objcPath = Buffer.from('/usr/lib/libobjc.A.dylib\0');
	const messageName = Buffer.from('objc_msgSend\0');
	const handle = loader.symbols.dlopen(ptr(objcPath), 2);
	const message = loader.symbols.dlsym(handle, ptr(messageName));
	const calls = linkSymbols({
		object: { ptr: message, args: [FFIType.u64, FFIType.ptr], returns: FFIType.u64 },
		objectArg: { ptr: message, args: [FFIType.u64, FFIType.ptr, FFIType.u64], returns: FFIType.u64 },
		scan: { ptr: message, args: [FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr], returns: FFIType.u64 },
		data: { ptr: message, args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.u64 },
		integer: { ptr: message, args: [FFIType.u64, FFIType.ptr], returns: FFIType.i64_fast },
		flag: { ptr: message, args: [FFIType.u64, FFIType.ptr], returns: FFIType.bool },
		supports: { ptr: message, args: [FFIType.u64, FFIType.ptr, FFIType.i64], returns: FFIType.bool },
		join: { ptr: message, args: [FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.u64, FFIType.ptr], returns: FFIType.bool },
	});
	const frameworkPath = Buffer.from('/System/Library/Frameworks/CoreWLAN.framework/CoreWLAN\0');
	const framework = loader.symbols.dlopen(ptr(frameworkPath), 2);
	if (!framework) throw new Error('macOS Wi-Fi framework is unavailable');
	const pool = objc.symbols.objc_autoreleasePoolPush();
	const buffers = [];
	const cString = value => {
		const buffer = Buffer.from(value + '\0', 'utf8');
		buffers.push(buffer);
		return ptr(buffer);
	};
	const selector = name => objc.symbols.sel_registerName(cString(name));
	const klass = name => {
		const result = objc.symbols.objc_getClass(cString(name));
		if (!result) throw new Error('macOS Wi-Fi framework is unavailable');
		return result;
	};
	const string = value => calls.symbols.objectArg(klass('NSString'), selector('stringWithUTF8String:'), cString(value));
	const get = (object, name) => calls.symbols.object(object, selector(name));
	const integer = (object, name) => Number(calls.symbols.integer(object, selector(name)));
	const flag = (object, name) => calls.symbols.flag(object, selector(name));
	const text = object => {
		if (!object) return null;
		const address = get(object, 'UTF8String');
		return address ? new CString(Number(address)).toString() : null;
	};
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
				if (current.device) result.push(coreWlanInterfaceState(current, coreWlanNamesVisible(current, networks)));
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
		if (request.operation !== 'associate') throw new Error('Unsupported macOS Wi-Fi operation');
		const { ssidHex, bssid, password, securityType } = request;
		const candidates = scan(iface, ssidHex);
		const network = selectCoreWlanTarget(candidates, ssidHex, securityType, bssid);
		if (snapshot(iface).ssidHex === ssidHex) throw new Error('macOS is already connected to that Wi-Fi network');
		// The selected CWNetwork retains its BSSID. Never issue a name-only join.
		errorBuffer[0] = 0n;
		const method = selector('associateToNetwork:password:error:');
		const key = securityType === 0 ? 0n : string(password);
		beginCoreWlanAssociation(request.phase);
		if (!calls.symbols.join(iface, method, network, key, ptr(errorBuffer))) throw nativeError('association');
		const actual = snapshot(iface);
		const selected = candidates.find(candidate => candidate.network === network);
		if (!coreWlanAssociationMatches(actual, ssidHex, selected.bssid, securityType)) throw new Error('macOS did not connect to the requested Wi-Fi network with the requested security');
	} finally {
		objc.symbols.objc_autoreleasePoolPop(pool);
		for (const buffer of buffers) buffer.fill(0);
		calls.close();
		loader.symbols.dlclose(framework);
		objc.close();
		loader.symbols.dlclose(handle);
		loader.close();
	}
}

if (!isMainThread)
	self.onmessage = event => {
		try {
			self.postMessage({ result: run(event.data) });
		} catch (error) {
			const password = event.data.password;
			const message = error instanceof Error ? error.message : 'macOS Wi-Fi association failed';
			self.postMessage({ error: password ? message.split(password).join('[redacted]') : message });
		} finally {
			event.data.password = '';
		}
	};
