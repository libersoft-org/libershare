// Plain JavaScript: Bun copies file assets into compiled binaries without transpiling imports.
import { dlopen, linkSymbols, FFIType, ptr, read, toArrayBuffer } from 'bun:ffi';
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
export function selectCoreWlanTarget(networks, ssidHex, securityType) {
	if (!networks.length) throw new Error('macOS Wi-Fi network is no longer available');
	for (const network of networks) {
		if (network.ssidHex !== ssidHex) throw new Error('macOS cannot identify the requested Wi-Fi network');
		if (network.securityType !== securityType) throw new Error('macOS Wi-Fi security changed or the network name is ambiguous');
	}
	return networks.reduce((best, item) => (item.signal > best.signal ? item : best)).network;
}

function associate({ device, ssid, password, securityType }) {
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
	try {
		const client = get(klass('CWWiFiClient'), 'sharedWiFiClient');
		const iface = calls.symbols.objectArg(client, selector('interfaceWithName:'), string(device));
		if (!iface) throw new Error('macOS Wi-Fi interface is unavailable');
		const expected = Buffer.from(ssid, 'utf8');
		buffers.push(expected);
		const ssidData = calls.symbols.data(klass('NSData'), selector('dataWithBytes:length:'), ptr(expected), BigInt(expected.length));
		const networks = calls.symbols.scan(iface, selector('scanForNetworksWithSSID:error:'), ssidData, ptr(errorBuffer));
		if (!networks) throw nativeError('scan');
		const iterator = get(networks, 'objectEnumerator');
		const candidates = [];
		for (let network = get(iterator, 'nextObject'); network; network = get(iterator, 'nextObject')) {
			const actual = bytes(get(network, 'ssidData'));
			const supports = type => calls.symbols.supports(network, selector('supportsSecurity:'), BigInt(type));
			const nativeSecurity = coreWlanSecurityType([0, 1, 2, 4, 6, 7, 9, 11, 12, 14, 15].filter(supports));
			candidates.push({ network, ssidHex: actual?.toString('hex'), securityType: nativeSecurity, signal: integer(network, 'rssiValue') });
		}
		const network = selectCoreWlanTarget(candidates, expected.toString('hex'), securityType);
		if (bytes(get(iface, 'ssidData'))?.equals(expected)) throw new Error('macOS is already connected to that Wi-Fi network');
		// The selected CWNetwork retains its BSSID. Never issue a name-only join.
		errorBuffer[0] = 0n;
		if (!calls.symbols.join(iface, selector('associateToNetwork:password:error:'), network, securityType === 0 ? 0n : string(password), ptr(errorBuffer))) throw nativeError('association');
		if (!bytes(get(iface, 'ssidData'))?.equals(expected)) throw new Error('macOS did not connect to the requested Wi-Fi network');
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
			associate(event.data);
			self.postMessage({});
		} catch (error) {
			const password = event.data.password;
			const message = error instanceof Error ? error.message : 'macOS Wi-Fi association failed';
			self.postMessage({ error: password ? message.split(password).join('[redacted]') : message });
		} finally {
			event.data.password = '';
		}
	};
