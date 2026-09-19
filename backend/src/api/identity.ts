import { type Networks } from '../lishnet/lishnets.ts';
import { Utils } from '../utils.ts';
import { type CompressionAlgorithm, type SuccessResponse, CodedError, ErrorCodes } from '@shared';
import { privateKeyFromProtobuf } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
const assert = Utils.assertParams;

interface IdentityBackup {
	peerID: string;
	privateKey: string; // base64-encoded libp2p PrivateKey protobuf
}

interface IdentityFile {
	privateKey: string; // base64-encoded libp2p PrivateKey protobuf
}

interface IdentityHandlers {
	get: () => IdentityBackup;
	exportToFile: (p: { filePath: string; minifyJSON?: boolean; compress?: boolean; compressionAlgorithm?: CompressionAlgorithm }) => Promise<SuccessResponse>;
	parseFromFile: (p: { filePath: string }) => Promise<IdentityBackup>;
	parseFromJSON: (p: { json: string }) => IdentityBackup;
	parseFromURL: (p: { url: string }) => Promise<IdentityBackup>;
	applyImported: (p: { privateKey: string }) => Promise<SuccessResponse>;
	regenerate: () => Promise<SuccessResponse>;
}

function validateBackup(data: unknown): asserts data is IdentityFile {
	if (!data || typeof data !== 'object' || Array.isArray(data)) throw new CodedError(ErrorCodes.INVALID_IDENTITY_BACKUP);
	const obj = data as Record<string, unknown>;
	if (typeof obj['privateKey'] !== 'string' || obj['privateKey'].length === 0) throw new CodedError(ErrorCodes.INVALID_IDENTITY_BACKUP);
}

function decodePrivateKey(base64: string): Uint8Array {
	try {
		return new Uint8Array(Buffer.from(base64, 'base64'));
	} catch {
		throw new CodedError(ErrorCodes.INVALID_IDENTITY_BACKUP);
	}
}

function toBackup(file: IdentityFile): IdentityBackup {
	let peerID: string;
	try {
		const bytes = decodePrivateKey(file.privateKey);
		const pk = privateKeyFromProtobuf(bytes);
		peerID = peerIdFromPrivateKey(pk).toString();
	} catch {
		throw new CodedError(ErrorCodes.INVALID_IDENTITY_BACKUP);
	}
	return { peerID, privateKey: file.privateKey };
}

export function initIdentityHandlers(networks: Networks): IdentityHandlers {
	const network = networks.getNetwork();

	function get(): IdentityBackup {
		const id = network.exportIdentity();
		if (!id) throw new CodedError(ErrorCodes.NETWORK_NOT_RUNNING);
		return { peerID: id.peerID, privateKey: Buffer.from(id.privateKeyBytes).toString('base64') };
	}

	async function exportToFile(p: { filePath: string; minifyJSON?: boolean; compress?: boolean; compressionAlgorithm?: CompressionAlgorithm }): Promise<SuccessResponse> {
		assert(p, ['filePath']);
		const resolved = Utils.expandHome(p.filePath);
		const backup = get();
		const file: IdentityFile = { privateKey: backup.privateKey };
		await Utils.writeJSONToFile(file, resolved, p.minifyJSON, p.compress, p.compressionAlgorithm);
		console.log(`✓ Identity exported to: ${resolved}`);
		return { success: true };
	}

	async function parseFromFile(p: { filePath: string }): Promise<IdentityBackup> {
		assert(p, ['filePath']);
		const text = await Utils.readFileCompressed(Utils.expandHome(p.filePath));
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (err) {
			throw new CodedError(ErrorCodes.INVALID_JSON, (err as Error).message);
		}
		validateBackup(parsed);
		return toBackup(parsed);
	}

	function parseFromJSON(p: { json: string }): IdentityBackup {
		assert(p, ['json']);
		let parsed: unknown;
		try {
			parsed = JSON.parse(p.json);
		} catch (err) {
			throw new CodedError(ErrorCodes.INVALID_JSON, (err as Error).message);
		}
		validateBackup(parsed);
		return toBackup(parsed);
	}

	async function parseFromURL(p: { url: string }): Promise<IdentityBackup> {
		assert(p, ['url']);
		const text = await Utils.fetchURL(p.url);
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (err) {
			throw new CodedError(ErrorCodes.INVALID_JSON, (err as Error).message);
		}
		validateBackup(parsed);
		return toBackup(parsed);
	}

	/**
	 * Run a stop → write → start sequence with lishnet writes blocked and older ones drained.
	 *
	 * Each of these sequences restarts every network around a write the restart then reads
	 * back, and neither of them is atomic on its own. Two of them, or one of them and a
	 * factory reset, interleaved their stops and starts: the reply reported the key this
	 * call wrote while the node came back up on the key the other one did, and a network
	 * stopped twice was subscribed by both starts. The factory reset already takes this
	 * lease, so taking it here puts every node-restarting operation in one queue.
	 */
	async function underMaintenance<T>(operation: () => Promise<T>): Promise<T> {
		const release = await networks.beginMaintenance();
		try {
			return await operation();
		} finally {
			release();
		}
	}

	async function applyImported(p: { privateKey: string }): Promise<SuccessResponse> {
		assert(p, ['privateKey']);
		const bytes = decodePrivateKey(p.privateKey);
		return underMaintenance(async () => {
			await networks.stopAllNetworks();
			try {
				await network.writeIdentityKey(bytes);
			} catch (err) {
				// Try to restart with old identity even on failure
				try {
					await networks.startEnabledNetworks();
				} catch {}
				throw err;
			}
			await networks.startEnabledNetworks();
			console.log('✓ Identity imported and network restarted');
			return { success: true };
		});
	}

	async function regenerate(): Promise<SuccessResponse> {
		return underMaintenance(async () => {
			await networks.stopAllNetworks();
			await network.clearIdentityKey();
			await networks.startEnabledNetworks();
			console.log('✓ Identity regenerated and network restarted');
			return { success: true };
		});
	}

	return { get, exportToFile, parseFromFile, parseFromJSON, parseFromURL, applyImported, regenerate };
}
