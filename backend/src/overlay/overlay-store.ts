import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { CodedError, ErrorCodes, type OverlayAccessRequest, type OverlayCertificateBundle, type OverlayMember, type OverlayPendingRequest, type OverlayRevocations, type SignedOverlayState } from '@shared';

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
	/**
	 * Every revocation this node has seen in any verified state, plus the fingerprints of revoked members' certificates
	 * found on its tunnels ({@link OverlayRevocations}). Only grows: a newer state without a revocation does not lift it.
	 */
	| 'revoked.json'
	/** Scratch files of one certificate issue or import, removed right after. */
	| 'issue.pub'
	| 'issue.crt'
	| 'issue.key'
	/** An invited node: its invite ({@link InviteFile}), guest certificate and key, and the guest Nebula configuration. */
	| 'invite.json'
	| 'guest.crt'
	| 'guest.key'
	| 'guest.yml';

/** What an invited node keeps of its invite until its certificate arrives. */
export interface InviteFile {
	id: string;
	founder: string;
	expires: string;
}

/** An invite the founder made ({@link OverlayInvite}). */
export interface FounderInvite {
	id: string;
	/** The guest certificate's address. */
	vpnIP: string;
	expires: string;
	/** The node whose request came in through it; the invite serves that node only. */
	peerID?: string;
	/** The certificate issued on it, handed out when the node asks again. */
	bundle?: OverlayCertificateBundle;
	refused?: boolean;
}

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
	/** Members revoked by peer ID ({@link OverlayRevocations.peers}), kept the same way. */
	revokedPeers?: Record<string, string>;
	/**
	 * The block of addresses this device hands out (256 per lane): 0 for the founding device, another one for each
	 * device restored from a backup, so two devices holding the CA key do not give two members one address.
	 */
	lane?: number;
	/** The lanes this device knows to be taken by devices holding the CA key, carried in backups. */
	lanes?: number[];
	/** Invites not yet expired. */
	invites?: FounderInvite[];
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

	async readRevocations(): Promise<OverlayRevocations> {
		return (await this.readJSON<OverlayRevocations>('revoked.json')) ?? { fingerprints: [], peers: {} };
	}

	async readFounder(): Promise<FounderData> {
		return (await this.readJSON<FounderData>('founder.json')) ?? { nextHost: 1, members: [], requests: [] };
	}
}
