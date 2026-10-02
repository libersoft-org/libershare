import { FFIType, ptr, type Pointer } from 'bun:ffi';
import { isMainThread } from 'node:worker_threads';
import { loadSystemLibrary } from '../library.ts';
import { classifyWmiMutation } from '../mutation-proof.ts';
import { comCall, guidBytes, releaseCom, withBstr, withComVariant } from './com.ts';
import { decodeWmiVariant, encodeWmiInput, type WmiInput, type WmiProperty, type WmiRow } from './wmi-values.ts';

export type WmiContext = Readonly<Record<string, string | boolean>>;
export interface WmiMutationResult {
	readonly hresult: number;
	readonly returnValue: number | null;
	readonly outcome: 'ok' | 'rejected' | 'failed' | 'unknown';
	readonly observationError?: string;
}
export interface WmiConnection {
	query(wql: string, properties: readonly string[], context?: WmiContext): WmiRow[];
	get(relativePath: string, properties: readonly string[], context?: WmiContext): WmiRow;
	put(relativePath: string, values: Readonly<Record<string, WmiInput>>, context?: WmiContext): WmiMutationResult;
	delete(relativePath: string, context?: WmiContext): WmiMutationResult;
	execMethod(objectPath: string, method: string, parameters: Readonly<Record<string, WmiInput>>, context?: WmiContext): WmiMutationResult;
	close(): void;
}

export class WmiError extends Error {
	readonly hresult: number;
	constructor(operation: string, hresult: number) {
		super(`${operation} failed: 0x${(hresult >>> 0).toString(16).padStart(8, '0')}`);
		this.name = 'WmiError';
		this.hresult = hresult;
	}
}

function check(hresult: number, operation: string): void {
	if (hresult !== 0) throw new WmiError(operation, hresult);
}

function pointer(out: BigUint64Array): Pointer {
	if (out[0] === 0n) throw new Error('WMI returned a null interface');
	return Number(out[0]) as Pointer;
}

const wide = (value: string): Buffer => Buffer.from(`${value}\0`, 'utf16le');

export function classifyWmiNext(hresult: number, count: number, hasObject: boolean): 'row' | 'end' {
	if (hresult === 0 && count === 1 && hasObject) return 'row';
	if (hresult === 1 && count === 0 && !hasObject) return 'end';
	throw new WmiError('IEnumWbemClassObject.Next', hresult);
}

function mutationResult(hresult: number, returnValue: number | null = null): WmiMutationResult {
	return { hresult, returnValue, outcome: classifyWmiMutation(hresult, returnValue) };
}

export function wmiMethodResult(hresult: number, output: WmiProperty | null): WmiMutationResult {
	if (hresult !== 0 || output === null) return mutationResult(hresult);
	let value = output.value;
	// CIM_UINT32 can use VT_I4 storage; its high bit is not a negative return code.
	if (output.cimType === 19 && output.variantType === 3 && typeof value === 'number' && Number.isInteger(value) && value >= -2147483648 && value <= 2147483647) value >>>= 0;
	if (value !== null && (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xffffffff)) return { hresult, returnValue: null, outcome: 'unknown', observationError: 'Invalid WMI ReturnValue' };
	return mutationResult(hresult, value);
}

function property(object: Pointer, name: string): WmiProperty {
	const key = wide(name);
	const cimType = new Int32Array(1);
	return withComVariant(variant => {
		check(comCall(object, 4, [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.ptr], [ptr(key), 0, ptr(variant), ptr(cimType), null]), 'IWbemClassObject.Get');
		return { ...decodeWmiVariant(variant), cimType: cimType[0]! };
	});
}

function row(object: Pointer, properties: readonly string[]): WmiRow {
	return Object.fromEntries(properties.map(name => [name, property(object, name)]));
}

function putProperties(object: Pointer, values: Readonly<Record<string, WmiInput>>): void {
	for (const [name, value] of Object.entries(values)) {
		const key = wide(name);
		withComVariant(variant => {
			encodeWmiInput(variant, value);
			check(comCall(object, 5, [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32], [ptr(key), 0, ptr(variant), 0]), 'IWbemClassObject.Put');
		});
	}
}

class Connection implements WmiConnection {
	private service: Pointer | null;
	private readonly create: (classId: string, interfaceId: string) => Pointer;
	private readonly secure: (object: Pointer) => void;
	private readonly dispose: () => void;

	constructor(service: Pointer, create: (classId: string, interfaceId: string) => Pointer, secure: (object: Pointer) => void, dispose: () => void) {
		this.service = service;
		this.create = create;
		this.secure = secure;
		this.dispose = dispose;
	}

	private use<T>(values: WmiContext, fn: (service: Pointer, context: Pointer | null) => T): T {
		if (this.service === null) throw new Error('WMI connection is closed');
		if (Object.keys(values).length === 0) return fn(this.service, null);
		const context = this.create('674B6698-EE92-11D0-AD71-00C04FD8FDFF', '44ACA674-E8FC-11D0-A07C-00C04FB68820');
		try {
			for (const [name, value] of Object.entries(values)) {
				const key = wide(name);
				withComVariant(variant => {
					encodeWmiInput(variant, typeof value === 'boolean' ? { type: 'boolean', value } : { type: 'string', value });
					check(comCall(context, 8, [FFIType.ptr, FFIType.i32, FFIType.ptr], [ptr(key), 0, ptr(variant)]), 'IWbemContext.SetValue');
				});
			}
			return fn(this.service, context);
		} finally {
			releaseCom(context);
		}
	}

	private object<T>(service: Pointer, path: string, context: Pointer | null, fn: (object: Pointer) => T): T {
		return withBstr(path, name => {
			const out = new BigUint64Array(1);
			check(comCall(service, 6, [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.ptr], [name, 0, context, ptr(out), null]), 'IWbemServices.GetObject');
			const object = pointer(out);
			try {
				return fn(object);
			} finally {
				releaseCom(object);
			}
		});
	}

	query(wql: string, properties: readonly string[], context: WmiContext = {}): WmiRow[] {
		return this.use(context, (service, ctx) =>
			withBstr('WQL', language =>
				withBstr(wql, query => {
					const out = new BigUint64Array(1);
					check(comCall(service, 20, [FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.ptr], [language, query, 0x30, ctx, ptr(out)]), 'IWbemServices.ExecQuery');
					const enumerator = pointer(out);
					try {
						this.secure(enumerator);
						const result: WmiRow[] = [];
						for (;;) {
							const item = new BigUint64Array(1),
								count = new Uint32Array(1);
							const hr = comCall(enumerator, 4, [FFIType.i32, FFIType.u32, FFIType.ptr, FFIType.ptr], [-1, 1, ptr(item), ptr(count)]);
							if (classifyWmiNext(hr, count[0]!, item[0] !== 0n) === 'end') return result;
							const object = pointer(item);
							try {
								result.push(row(object, properties));
							} finally {
								releaseCom(object);
							}
						}
					} finally {
						releaseCom(enumerator);
					}
				})
			)
		);
	}

	get(relativePath: string, properties: readonly string[], context: WmiContext = {}): WmiRow {
		return this.use(context, (service, ctx) => this.object(service, relativePath, ctx, object => row(object, properties)));
	}

	put(relativePath: string, values: Readonly<Record<string, WmiInput>>, context: WmiContext = {}): WmiMutationResult {
		return this.use(context, (service, ctx) =>
			this.object(service, relativePath, ctx, object => {
				putProperties(object, values);
				// WBEM_FLAG_UPDATE_ONLY: an absent instance must not be recreated during rollback.
				return mutationResult(comCall(service, 14, [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.ptr], [object, 1, ctx, null]));
			})
		);
	}

	delete(relativePath: string, context: WmiContext = {}): WmiMutationResult {
		return this.use(context, (service, ctx) => withBstr(relativePath, path => mutationResult(comCall(service, 16, [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.ptr], [path, 0, ctx, null]))));
	}

	execMethod(objectPath: string, method: string, parameters: Readonly<Record<string, WmiInput>>, context: WmiContext = {}): WmiMutationResult {
		return this.use(context, (service, ctx) =>
			this.object(service, objectPath, ctx, target => {
				const className = property(target, '__CLASS').value;
				if (typeof className !== 'string') throw new Error('WMI object has no class name');
				// GetMethod is only valid on a class definition, not an instance.
				return this.object(service, className, ctx, definition => {
					const signatureOut = new BigUint64Array(1);
					const methodName = wide(method);
					check(comCall(definition, 19, [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.ptr], [ptr(methodName), 0, ptr(signatureOut), null]), 'IWbemClassObject.GetMethod');
					const signature = signatureOut[0] === 0n ? null : pointer(signatureOut);
					let input: Pointer | null = null;
					try {
						if (signature !== null) {
							const instance = new BigUint64Array(1);
							check(comCall(signature, 15, [FFIType.i32, FFIType.ptr], [0, ptr(instance)]), 'IWbemClassObject.SpawnInstance');
							input = pointer(instance);
							putProperties(input, parameters);
						} else if (Object.keys(parameters).length) throw new Error('WMI method has no input parameters');
						return withBstr(objectPath, path =>
							withBstr(method, name => {
								const out = new BigUint64Array(1);
								const hr = comCall(service, 24, [FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], [path, name, 0, ctx, input, ptr(out), null]);
								if (hr !== 0 || out[0] === 0n) return mutationResult(hr);
								const output = pointer(out);
								try {
									return wmiMethodResult(hr, property(output, 'ReturnValue'));
								} catch {
									return { hresult: hr, returnValue: null, outcome: 'unknown', observationError: 'Cannot read WMI method ReturnValue' };
								} finally {
									releaseCom(output);
								}
							})
						);
					} finally {
						if (input !== null) releaseCom(input);
						if (signature !== null) releaseCom(signature);
					}
				});
			})
		);
	}

	close(): void {
		if (this.service === null) return;
		const service = this.service;
		this.service = null;
		try {
			releaseCom(service);
		} finally {
			this.dispose();
		}
	}
}

/** Blocking WMI calls belong to a dedicated native worker, never the event-loop thread. */
export function openWmiConnection(namespace: string = 'ROOT\\StandardCimv2'): WmiConnection {
	if (isMainThread) throw new Error('WMI requires a native worker');
	if (process.platform !== 'win32') throw new Error('WMI is only available on Windows');
	const library = loadSystemLibrary('ole32.dll', {
		CoInitializeEx: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
		CoUninitialize: { args: [], returns: FFIType.void },
		CoCreateInstance: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
		CoSetProxyBlanket: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
	} as const);
	const initialized = library.symbols.CoInitializeEx(null, 0);
	if (initialized !== 0 && initialized !== 1 && initialized >>> 0 !== 0x80010106) {
		library.close();
		throw new WmiError('CoInitializeEx', initialized);
	}
	const dispose = (): void => {
		if (initialized === 0 || initialized === 1) library.symbols.CoUninitialize();
		library.close();
	};
	const create = (classId: string, interfaceId: string): Pointer => {
		const clsid = guidBytes(classId),
			iid = guidBytes(interfaceId),
			out = new BigUint64Array(1);
		check(library.symbols.CoCreateInstance(ptr(clsid), null, 1, ptr(iid), ptr(out)), 'CoCreateInstance');
		return pointer(out);
	};
	const secure = (object: Pointer): void => {
		check(library.symbols.CoSetProxyBlanket(object, 10, 0, null, 3, 3, null, 0), 'CoSetProxyBlanket');
	};
	try {
		const locator = create('4590F811-1D3A-11D0-891F-00AA004B2E24', 'DC12A687-737F-11CF-884D-00AA004B2E24');
		try {
			return withBstr(namespace, name => {
				const out = new BigUint64Array(1);
				check(comCall(locator, 3, [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.ptr], [name, null, null, null, 0, null, null, ptr(out)]), 'IWbemLocator.ConnectServer');
				const service = pointer(out);
				try {
					secure(service);
				} catch (error) {
					releaseCom(service);
					throw error;
				}
				return new Connection(service, create, secure, dispose);
			});
		} finally {
			releaseCom(locator);
		}
	} catch (error) {
		dispose();
		throw error;
	}
}
