import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { CodedError, ErrorCodes, type OverlayAccessRequest, type OverlayMember, type OverlayPendingRequest, type SignedOverlayState } from '@shared';

/** Files of one protected lishnet. Keys are written once, owner-readable only, and never leave this directory. */
export type OverlayFile =
	/** This node's Nebula private key and public key (PEM). */
	| 'member.key'
	| 'member.pub'
	/** This node's certificate, once the founder issued it. */
	| 'member.crt'
	/** The CA certificate, copied from the definition for Nebula. */
	| 'ca.crt'
	/** The CA signing key: present on the founder's node only. */
	| 'ca.key'
	| 'nebula.yml'
	/** This node's own access request ({@link OverlayAccessRequest}). */
	| 'request.json'
	/** Founder bookkeeping ({@link FounderData}). */
	| 'founder.json'
	/** The newest signed state this node has verified ({@link SignedOverlayState}). */
	| 'state.json'
	/** Scratch files of one certificate issue or import, removed right after. */
	| 'issue.pub'
	| 'issue.crt';

/** What the founder keeps about the lishnet's members. */
export interface FounderData {
	/** Index of the next overlay address to hand out (1 = first address of the subnet). */
	nextHost: number;
	members: OverlayMember[];
	requests: OverlayPendingRequest[];
	/**
	 * Revocations known from a signed state or a restored backup but not from {@link members}: one made on another
	 * device holding the CA key. Every new state keeps them.
	 */
	revoked?: string[];
}

/** A network ID is used as a directory name, so it must not be able to name anything but one directory. */
export function assertSafeNetworkID(networkID: string): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(networkID) || networkID.includes('..')) throw new CodedError(ErrorCodes.NETWORK_INVALID, 'network ID cannot be used as a directory name');
}

/** Directory of a lishnet's overlay data: `<dataDir>/lishnet-nodes/<networkID>/`. */
export function overlayDir(dataDir: string, networkID: string): string {
	assertSafeNetworkID(networkID);
	return join(dataDir, 'lishnet-nodes', networkID);
}

export class OverlayStore {
	readonly dir: string;

	constructor(dataDir: string, networkID: string) {
		this.dir = overlayDir(dataDir, networkID);
	}

	path(name: OverlayFile): string {
		return join(this.dir, name);
	}

	has(name: OverlayFile): boolean {
		return existsSync(this.path(name));
	}

	async ensureDir(): Promise<void> {
		await mkdir(this.dir, { recursive: true, mode: 0o700 });
	}

	async readText(name: OverlayFile): Promise<string | null> {
		try {
			return await readFile(this.path(name), 'utf8');
		} catch (err: any) {
			if (err?.code === 'ENOENT') return null;
			throw err;
		}
	}

	async readJSON<T>(name: OverlayFile): Promise<T | null> {
		const text = await this.readText(name);
		return text === null ? null : (JSON.parse(text) as T);
	}

	/** Replace a file atomically (unique sibling, flush, rename), so a crash leaves the old or the new content. */
	async writeText(name: OverlayFile, text: string): Promise<void> {
		await this.ensureDir();
		const target = this.path(name);
		const staging = `${target}.${randomUUID()}.tmp`;
		try {
			const handle = await open(staging, 'wx', 0o600);
			try {
				await handle.writeFile(text);
				await handle.sync();
			} finally {
				await handle.close();
			}
			await rename(staging, target);
		} catch (err) {
			await unlink(staging).catch(() => {});
			throw err;
		}
	}

	async writeJSON(name: OverlayFile, value: unknown): Promise<void> {
		await this.writeText(name, JSON.stringify(value, null, '\t'));
	}

	async remove(name: OverlayFile): Promise<void> {
		await rm(this.path(name), { force: true });
	}

	/** Delete everything of this lishnet, keys included. */
	async removeAll(): Promise<void> {
		await rm(this.dir, { recursive: true, force: true });
	}

	readRequest(): Promise<OverlayAccessRequest | null> {
		return this.readJSON<OverlayAccessRequest>('request.json');
	}

	readState(): Promise<SignedOverlayState | null> {
		return this.readJSON<SignedOverlayState>('state.json');
	}

	async readFounder(): Promise<FounderData> {
		return (await this.readJSON<FounderData>('founder.json')) ?? { nextHost: 1, members: [], requests: [] };
	}
}
