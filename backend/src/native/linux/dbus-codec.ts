import { CString, ptr, read, type Pointer } from 'bun:ffi';
import { checkSdBus, nativePointer, type SdBusSymbols } from './dbus-native.ts';

export interface DBusVariant {
	readonly sig: string;
	readonly value: DBusValue;
}
export type DBusValue = string | number | bigint | boolean | Uint8Array | DBusVariant | DBusValue[] | { [key: string]: DBusValue } | Map<DBusValue, DBusValue>;
export const DBUS_LIMITS: Readonly<{ depth: number; arrayElements: number; bytes: number }> = { depth: 32, arrayElements: 10_000, bytes: 4 * 1024 * 1024 };

export function variant(sig: string, value: DBusValue): DBusVariant {
	if (splitDBusSignature(sig).length !== 1) throw new Error('A variant needs one complete type');
	return { sig, value };
}

export function splitDBusSignature(signature: string): string[] {
	if (signature.length > 255) throw new Error('D-Bus signature exceeds 255 bytes');
	let offset = 0;
	const parse = (depth: number, dictionaryAllowed = false): void => {
		if (depth > DBUS_LIMITS.depth) throw new Error('D-Bus nesting limit exceeded');
		const type = signature[offset++];
		if (type && 'ybnqiuxtdsogv'.includes(type)) return;
		if (type === 'a') return parse(depth + 1, true);
		if (type === '(') {
			const start = offset;
			while (offset < signature.length && signature[offset] !== ')') parse(depth + 1);
			if (offset === start || signature[offset++] !== ')') throw new Error('Invalid D-Bus struct signature');
			return;
		}
		if (type === '{' && dictionaryAllowed) {
			if (!signature[offset] || !'ybnqiuxtdsog'.includes(signature[offset]!)) throw new Error('Invalid D-Bus dictionary key');
			parse(depth + 1);
			parse(depth + 1);
			if (signature[offset++] !== '}') throw new Error('Invalid D-Bus dictionary signature');
			return;
		}
		// File descriptors are borrowed from the message and cannot cross the worker boundary.
		throw new Error(`Unsupported or malformed D-Bus signature at ${offset - 1}`);
	};
	const types: string[] = [];
	while (offset < signature.length) {
		const start = offset;
		parse(0);
		types.push(signature.slice(start, offset));
	}
	return types;
}

export function dbusCString(value: string): Buffer {
	if (value.includes('\0')) throw new Error('D-Bus strings cannot contain NUL');
	if (Buffer.byteLength(value) > DBUS_LIMITS.bytes) throw new Error('D-Bus byte limit exceeded');
	return Buffer.from(`${value}\0`, 'utf8');
}

/** Copies message-owned UTF-8 bytes while the message is still alive. */
export function copyDBusString(value: number | bigint | null, limit: number = DBUS_LIMITS.bytes): string | null {
	if (!value) return null;
	const address = nativePointer(value);
	let length = 0;
	while (length <= limit && read.u8(address, length) !== 0) length++;
	if (length > limit) throw new Error('D-Bus byte limit exceeded');
	if (length === 0) return '';
	return new CString(address, 0, length).toString();
}

class Budget {
	bytes = 0;
	add(bytes: number, depth: number): void {
		if (depth > DBUS_LIMITS.depth) throw new Error('D-Bus nesting limit exceeded');
		this.bytes += bytes;
		if (this.bytes > DBUS_LIMITS.bytes) throw new Error('D-Bus byte limit exceeded');
	}
}

function scalarBuffer(type: string, value: DBusValue): Buffer {
	if ('sog'.includes(type)) {
		if (typeof value !== 'string') throw new Error(`Expected D-Bus ${type} string`);
		if (type === 'g') splitDBusSignature(value);
		return dbusCString(value);
	}
	if (type === 'b') {
		if (typeof value !== 'boolean') throw new Error('Expected D-Bus boolean');
		const result = Buffer.alloc(4);
		result.writeInt32LE(value ? 1 : 0);
		return result;
	}
	const size = type === 'y' ? 1 : 'nq'.includes(type) ? 2 : 'iu'.includes(type) ? 4 : 8;
	const result = Buffer.alloc(size);
	if (type === 'x' || type === 't') {
		if (typeof value !== 'bigint') throw new Error('D-Bus 64-bit integers require bigint');
		if (type === 'x') result.writeBigInt64LE(value);
		else result.writeBigUInt64LE(value);
		return result;
	}
	if (typeof value !== 'number' || (type !== 'd' && !Number.isInteger(value))) throw new Error(`Expected D-Bus ${type} number`);
	switch (type) {
		case 'y':
			result.writeUInt8(value);
			break;
		case 'n':
			result.writeInt16LE(value);
			break;
		case 'q':
			result.writeUInt16LE(value);
			break;
		case 'i':
			result.writeInt32LE(value);
			break;
		case 'u':
			result.writeUInt32LE(value);
			break;
		case 'd':
			result.writeDoubleLE(value);
			break;
		default:
			throw new Error(`Unsupported D-Bus scalar ${type}`);
	}
	return result;
}

export function encodeDBus(sd: SdBusSymbols, message: Pointer, signature: string, args: readonly DBusValue[]): void {
	const budget = new Budget();
	const open = (type: string, contents: string): void => {
		const text = dbusCString(contents);
		checkSdBus(sd.sd_bus_message_open_container(message, type.charCodeAt(0), ptr(text)), 'open container');
	};
	const close = (): void => {
		checkSdBus(sd.sd_bus_message_close_container(message), 'close container');
	};
	const encode = (type: string, value: DBusValue, depth: number): void => {
		budget.add(0, depth);
		if (type.startsWith('a')) {
			const inner = type.slice(1);
			if (inner.startsWith('{')) {
				if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof Uint8Array) throw new Error('Expected D-Bus dictionary');
				const entries = value instanceof Map ? [...value.entries()] : Object.entries(value);
				if (entries.length > DBUS_LIMITS.arrayElements) throw new Error('D-Bus array limit exceeded');
				const [keyType, valueType] = splitDBusSignature(inner.slice(1, -1));
				if (!(value instanceof Map) && !'sog'.includes(keyType!)) throw new Error('Non-string D-Bus dictionaries require Map');
				open('a', inner);
				for (const [key, item] of entries) {
					budget.add(8, depth + 1);
					open('e', inner.slice(1, -1));
					encode(keyType!, key, depth + 2);
					encode(valueType!, item, depth + 2);
					close();
				}
			} else {
				if (!Array.isArray(value) && !(inner === 'y' && value instanceof Uint8Array)) throw new Error('Expected D-Bus array');
				if (value.length > DBUS_LIMITS.arrayElements) throw new Error('D-Bus array limit exceeded');
				open('a', inner);
				for (const item of value) encode(inner, item, depth + 1);
			}
			budget.add(8, depth);
			close();
		} else if (type === 'v') {
			if (!value || typeof value !== 'object' || !('sig' in value) || typeof value.sig !== 'string' || !('value' in value)) throw new Error('Expected typed D-Bus variant');
			if (splitDBusSignature(value.sig).length !== 1) throw new Error('A variant needs one complete type');
			budget.add(value.sig.length + 2, depth);
			open('v', value.sig);
			encode(value.sig, value.value, depth + 1);
			close();
		} else if (type.startsWith('(')) {
			const inner = type.slice(1, -1);
			const fields = splitDBusSignature(inner);
			if (!Array.isArray(value) || fields.length !== value.length) throw new Error('D-Bus struct arity mismatch');
			budget.add(8, depth);
			open('r', inner);
			fields.forEach((field, index) => encode(field, value[index]!, depth + 1));
			close();
		} else {
			if (typeof value === 'string') budget.add(Buffer.byteLength(value) + 5, depth);
			const buffer = scalarBuffer(type, value);
			if (typeof value !== 'string') budget.add(buffer.length, depth);
			checkSdBus(sd.sd_bus_message_append_basic(message, type.charCodeAt(0), ptr(buffer)), 'append basic');
		}
	};
	const types = splitDBusSignature(signature);
	if (types.length !== args.length) throw new Error('D-Bus argument count does not match signature');
	types.forEach((type, index) => encode(type, args[index]!, 0));
}

export function decodeDBus(sd: SdBusSymbols, message: Pointer): DBusValue[] {
	const budget = new Budget();
	const decode = (depth: number): DBusValue | undefined => {
		budget.add(0, depth);
		const typeOut = new Uint8Array(1);
		const contentsOut = new BigUint64Array(1);
		if (checkSdBus(sd.sd_bus_message_peek_type(message, ptr(typeOut), ptr(contentsOut)), 'peek type') === 0) return undefined;
		const type = String.fromCharCode(typeOut[0]!);
		if ('avre'.includes(type)) {
			const contents = copyDBusString(contentsOut[0] ? nativePointer(contentsOut[0]) : null, 255) ?? '';
			const fields = splitDBusSignature(type === 'a' ? `a${contents}` : contents);
			const text = dbusCString(contents);
			if (sd.sd_bus_message_enter_container(message, type.charCodeAt(0), ptr(text)) <= 0) throw new Error('Cannot enter D-Bus container');
			budget.add(8 + contents.length, depth);
			const items: DBusValue[] = [];
			while (true) {
				const item = decode(depth + 1);
				if (item === undefined) break;
				if (items.length >= DBUS_LIMITS.arrayElements) throw new Error('D-Bus array limit exceeded');
				items.push(item);
			}
			checkSdBus(sd.sd_bus_message_exit_container(message), 'exit container');
			if (type === 'v') {
				if (fields.length !== 1 || items.length !== 1) throw new Error('Invalid D-Bus variant');
				return { sig: contents, value: items[0]! };
			}
			if (type === 'r' || type === 'e') {
				if (fields.length !== items.length) throw new Error('D-Bus container arity mismatch');
				return items;
			}
			if (contents === 'y') return Uint8Array.from(items as number[]);
			if (contents.startsWith('{')) {
				const stringKeys = 'sog'.includes(contents[1]!);
				const result: { [key: string]: DBusValue } = {};
				const map = new Map<DBusValue, DBusValue>();
				for (const item of items) {
					if (!Array.isArray(item) || item.length !== 2) throw new Error('Invalid D-Bus dictionary entry');
					if (stringKeys) Object.defineProperty(result, item[0] as string, { value: item[1], enumerable: true, writable: true, configurable: true });
					else map.set(item[0]!, item[1]!);
				}
				return stringKeys ? result : map;
			}
			return items;
		}
		if (!'ybnqiuxtdsog'.includes(type)) throw new Error(`Unsupported D-Bus scalar ${type}`);
		const buffer = Buffer.alloc(8);
		if (sd.sd_bus_message_read_basic(message, type.charCodeAt(0), ptr(buffer)) <= 0) throw new Error('Cannot read D-Bus value');
		if ('sog'.includes(type)) {
			const value = copyDBusString(nativePointer(buffer.readBigUInt64LE()), DBUS_LIMITS.bytes - budget.bytes);
			if (value === null) throw new Error('Null D-Bus string');
			budget.add(Buffer.byteLength(value) + 5, depth);
			return value;
		}
		budget.add(type === 'y' ? 1 : 'nq'.includes(type) ? 2 : 'biu'.includes(type) ? 4 : 8, depth);
		switch (type) {
			case 'y':
				return buffer.readUInt8();
			case 'b':
				return buffer.readInt32LE() !== 0;
			case 'n':
				return buffer.readInt16LE();
			case 'q':
				return buffer.readUInt16LE();
			case 'i':
				return buffer.readInt32LE();
			case 'u':
				return buffer.readUInt32LE();
			case 'x':
				return buffer.readBigInt64LE();
			case 't':
				return buffer.readBigUInt64LE();
			case 'd':
				return buffer.readDoubleLE();
			default:
				throw new Error('Invalid D-Bus scalar');
		}
	};
	const values: DBusValue[] = [];
	while (true) {
		const value = decode(0);
		if (value === undefined) return values;
		values.push(value);
	}
}
