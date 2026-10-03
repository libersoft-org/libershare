import { CString, linkSymbols, ptr, type Library, type Pointer } from 'bun:ffi';
import { loadSystemLibrary } from '../library.ts';

const runtimeSymbols = {
	objc_getClass: { args: ['ptr'], returns: 'u64' },
	sel_registerName: { args: ['ptr'], returns: 'ptr' },
	objc_autoreleasePoolPush: { args: [], returns: 'ptr' },
	objc_autoreleasePoolPop: { args: ['ptr'], returns: 'void' },
} as const;
const signatures = {
	object: { args: ['u64', 'ptr'], returns: 'u64' },
	objectArg: { args: ['u64', 'ptr', 'u64'], returns: 'u64' },
	stringArg: { args: ['u64', 'ptr', 'ptr'], returns: 'u64' },
	scan: { args: ['u64', 'ptr', 'u64', 'ptr'], returns: 'u64' },
	data: { args: ['u64', 'ptr', 'ptr', 'u64'], returns: 'u64' },
	integer: { args: ['u64', 'ptr'], returns: 'i64' },
	flag: { args: ['u64', 'ptr'], returns: 'bool' },
	flagArg: { args: ['u64', 'ptr', 'u64'], returns: 'bool' },
	supports: { args: ['u64', 'ptr', 'i64'], returns: 'bool' },
	disconnect: { args: ['u64', 'ptr'], returns: 'void' },
	join: { args: ['u64', 'ptr', 'u64', 'u64', 'ptr'], returns: 'bool' },
} as const;
let runtime: Library<typeof runtimeSymbols> | undefined;
const frameworks = new Map<string, Library<typeof runtimeSymbols>>();

export class ObjectiveC {
	readonly calls: Library<typeof signatures>;
	readonly buffers: Buffer[] = [];
	private readonly runtime: Library<typeof runtimeSymbols>;
	private pool: Pointer | null;
	constructor(framework: 'AppKit' | 'CoreWLAN') {
		this.runtime = runtime ??= loadSystemLibrary('/usr/lib/libobjc.A.dylib', runtimeSymbols);
		if (!frameworks.has(framework)) frameworks.set(framework, loadSystemLibrary(`/System/Library/Frameworks/${framework}.framework/${framework}`, runtimeSymbols));
		const system = loadSystemLibrary('/usr/lib/libSystem.B.dylib', { dlsym: { args: ['u64', 'ptr'], returns: 'ptr' } });
		try {
			const name = Buffer.from('objc_msgSend\0');
			const address = system.symbols.dlsym(0xfffffffffffffffen, ptr(name)); // RTLD_DEFAULT
			if (!address) throw new Error('Objective-C message dispatch is unavailable');
			this.calls = linkSymbols(Object.fromEntries(Object.entries(signatures).map(([name, signature]) => [name, { ...signature, ptr: address }])) as unknown as typeof signatures);
		} finally {
			system.close();
		}
		this.pool = (Number(this.runtime.symbols.objc_autoreleasePoolPush()) as Pointer) || null;
		if (!this.pool) {
			this.calls.close();
			throw new Error('Objective-C autorelease pool is unavailable');
		}
	}
	cString(value: string): Pointer {
		if (value.includes('\0')) throw new Error('Objective-C string contains NUL');
		const buffer = Buffer.from(value + '\0', 'utf8');
		this.buffers.push(buffer);
		return ptr(buffer);
	}
	selector(name: string): Pointer {
		return Number(this.runtime.symbols.sel_registerName(this.cString(name))) as Pointer;
	}
	klass(name: string): bigint {
		const result = BigInt(this.runtime.symbols.objc_getClass(this.cString(name)));
		if (!result) throw new Error(`Objective-C class ${name} is unavailable`);
		return result;
	}
	// Tagged NSString objects need all 64 bits; FFI pointer Numbers truncate them.
	string(value: string): bigint {
		return BigInt(this.calls.symbols.stringArg(this.klass('NSString'), this.selector('stringWithUTF8String:'), this.cString(value)));
	}
	get(object: bigint, name: string): bigint {
		return BigInt(this.calls.symbols.object(object, this.selector(name)));
	}
	integer(object: bigint, name: string): number {
		return Number(this.calls.symbols.integer(object, this.selector(name)));
	}
	flag(object: bigint, name: string): boolean {
		return this.calls.symbols.flag(object, this.selector(name));
	}
	text(object: bigint): string | null {
		if (!object) return null;
		const address = this.get(object, 'UTF8String');
		return address ? new CString(Number(address) as Pointer).toString() : null;
	}
	close(): void {
		if (!this.pool) return;
		this.runtime.symbols.objc_autoreleasePoolPop(this.pool);
		this.pool = null;
		for (const buffer of this.buffers) buffer.fill(0);
		this.buffers.length = 0;
		this.calls.close();
	}
}
