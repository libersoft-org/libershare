import { mkdir, open } from 'fs/promises';
import { join, dirname } from 'path';
import { type IStoredLISH, type LISHid, type ChunkID, CodedError, ErrorCodes } from '@shared';
import { type Network } from './network.ts';
import { lishTopic } from './constants.ts';
import { Utils } from '../utils.ts';
import { multiaddr, type Multiaddr } from '@multiformats/multiaddr';
import { type HaveChunks, LISH_PROTOCOL, LISHClient } from './lish-protocol.ts';
import { Mutex } from 'async-mutex';
import { DataServer, type MissingChunk } from '../lish/data-server.ts';

type NodeID = string;
interface PubsubMessage {
	type: 'want' | 'have';
	lishID: LISHid;
}
export interface WantMessage extends PubsubMessage {
	type: 'want';
}
export interface HaveMessage extends PubsubMessage {
	type: 'have';
	lishID: LISHid;
	peerID: NodeID;
	multiaddrs: Multiaddr[];
	chunks: HaveChunks;
}
type State = 'added' | 'initializing' | 'initialized' | 'preparing' | 'awaiting-manifest' | 'downloading' | 'downloaded';

export class Downloader {
	private lish!: IStoredLISH;
	private readonly dataServer: DataServer;
	private network: Network;
	private readonly downloadDir: string;
	private readonly networkID: string;
	private lishID!: LISHid;
	private state: State = 'added';
	private workMutex = new Mutex();
	private missingChunks: MissingChunk[] = [];
	private peers: Map<NodeID, LISHClient> = new Map();
	private lastServingPeerCount = 0;
	private failedPeers = new Set<NodeID>(); // peers that failed — don't re-probe until next cycle
	private callForPeersInterval: NodeJS.Timeout | undefined;
	private needsManifest = false;
	private paused = false;
	private lastExhaustedTime = 0;
	private downloadActive = false; // true while downloadChunks is running inside workMutex
	private pauseResolve: (() => void) | undefined;
	private downloadResolve: (() => void) | undefined;
	private downloadReject: ((err: Error) => void) | undefined;
	private onProgress?: (info: { downloadedChunks: number; totalChunks: number; peers: number; bytesPerSecond: number }) => void;
	private onManifestImported?: (lishID: string) => void;
	private downloadStartTime = 0;
	private downloadedBytes = 0;
	private speedSamples: { time: number; bytes: number }[] = [];

	getLISHID(): string { return this.lishID; }
	getPeerCount(): number { return this.lastServingPeerCount; }

	setProgressCallback(cb: (info: { downloadedChunks: number; totalChunks: number; peers: number; bytesPerSecond: number }) => void): void {
		this.onProgress = cb;
	}

	setManifestImportedCallback(cb: (lishID: string) => void): void {
		this.onManifestImported = cb;
	}

	pause(): void {
		this.paused = true;
		console.log(`[DL] Paused ${this.lishID.slice(0, 8)}`);
	}

	resume(): void {
		this.paused = false;
		this.lastExhaustedTime = 0; // allow immediate retry on resume
		console.log(`[DL] Resumed ${this.lishID.slice(0, 8)}`);
		this.pauseResolve?.();
		this.pauseResolve = undefined;
		// Probe for new peers on resume (may find peers that joined while paused)
		this.probeTopicPeers().catch(() => {});
		// Re-trigger doWork in case it was waiting
		if (this.state === 'downloading') this.doWork().then(() => {});
	}

	isPaused(): boolean { return this.paused; }

	getLishID(): string { return this.lishID; }

	private async waitIfPaused(): Promise<void> {
		if (!this.paused) return;
		await new Promise<void>(resolve => { this.pauseResolve = resolve; });
	}

	constructor(downloadDir: string, network: Network, dataServer: DataServer, networkID: string) {
		this.downloadDir = downloadDir;
		this.network = network;
		this.dataServer = dataServer;
		this.networkID = networkID;
	}

	async init(lishPath: string): Promise<void> {
		this.state = 'initializing';
		// Read and parse LISH
		const content = await Bun.file(lishPath).text();
		this.lish = Utils.safeJSONParse(content, `LISH file: ${lishPath}`);
		this.lishID = this.lish.id as LISHid;
		console.log(`[DL] Loading LISH: ${this.lish.name} (${this.lishID.slice(0, 8)}), ${this.dataServer.getMissingChunks(this.lishID).length} chunks to download`);
		this.missingChunks = this.dataServer.getMissingChunks(this.lishID);
		const topic = lishTopic(this.networkID);
		await this.network.subscribe(topic, async data => {
			await this.handlePubsubMessage(topic, data);
		});
		this.state = 'initialized';
	}

	async initFromManifest(lish: IStoredLISH): Promise<void> {
		this.state = 'initializing';
		this.lish = lish;
		this.lishID = this.lish.id as LISHid;
		// Check if we already have the full manifest in DB
		const existingChunks = this.dataServer.getMissingChunks(this.lishID);
		if (existingChunks.length > 0 || this.dataServer.isCompleteLISH(lish)) {
			this.missingChunks = existingChunks;
			console.log(`[DL] Loading LISH: ${this.lish.name} (${this.lishID.slice(0, 8)}), ${this.missingChunks.length} chunks to download`);
		} else {
			this.needsManifest = true;
			console.log(`[DL] Loading LISH: ${this.lish.name} (${this.lishID.slice(0, 8)}), awaiting manifest from peer`);
		}
		const topic = lishTopic(this.networkID);
		await this.network.subscribe(topic, async data => {
			await this.handlePubsubMessage(topic, data);
		});
		this.state = 'initialized';
	}

	// Main download loop — returns only when fully downloaded (or throws on error)
	async download(): Promise<void> {
		if (this.state !== 'initialized') throw new CodedError(ErrorCodes.DOWNLOADER_NOT_INITIALIZED);
		if (this.needsManifest) {
			this.state = 'awaiting-manifest';
			await this.callForPeers();
		} else {
			this.state = 'preparing';
			await this.doWork();
		}
		// Wait until state reaches 'downloaded' — doWork is called from peer handler
		if (this.state !== 'downloaded') {
			await new Promise<void>((resolve, reject) => {
				this.downloadResolve = resolve;
				this.downloadReject = reject;
			});
		}
	}

	async doWork(): Promise<void> {
		// Throttle: don't re-enter within 10s of last exhausted cycle
		if (this.lastExhaustedTime > 0 && Date.now() - this.lastExhaustedTime < 10000) return;
		// Skip if downloadChunks is already running — new peers get picked up dynamically
		if (this.workMutex.isLocked()) return;
		await this.workMutex.runExclusive(async () => {
			// Phase 1: fetch manifest from a peer if needed
			if (this.state === 'awaiting-manifest') {
				if (this.peers.size === 0) return;
				for (const [, client] of this.peers) {
					const manifest = await client.requestManifest(this.lishID);
					if (manifest && manifest.files && manifest.files.length > 0) {
						this.lish = { ...manifest, directory: this.downloadDir };
						this.dataServer.add(this.lish);
						this.onManifestImported?.(this.lishID);
						this.missingChunks = this.dataServer.getMissingChunks(this.lishID);
						this.needsManifest = false;
						console.log(`[DL] Got manifest: ${manifest.files.length} files, ${this.missingChunks.length} chunks`);
						this.state = 'preparing';
						break;
					}
				}
				if (this.needsManifest) return;
			}
			// Phase 2: create directory structure
			if (this.state === 'preparing') {
				await this.createDirectoryStructure();
				this.state = 'downloading';
			}
			// Phase 3: download chunks
			if (this.state === 'downloading') {
				if (this.missingChunks.length === 0) {
					console.log(`[DL] Complete: ${this.lishID.slice(0, 8)}`);
					this.state = 'downloaded';
					this.downloadResolve?.();
					return;
				}
				if (this.peers.size === 0) {
					this.failedPeers.clear();
					await this.callForPeers();
					if (this.peers.size === 0) {
						this.lastExhaustedTime = Date.now();
						setTimeout(() => { if (this.state === 'downloading' && !this.paused) this.doWork().catch(() => {}); }, 10000);
						return;
					}
				}
				if (this.peers.size !== 0) {
					this.downloadActive = true;
					try { await this.downloadChunks(); } finally { this.downloadActive = false; }
					const remaining = this.dataServer.getMissingChunks(this.lishID);
					if (remaining.length === 0) {
						console.log(`[DL] Complete: ${this.lishID.slice(0, 8)}`);
						this.state = 'downloaded';
						this.downloadResolve?.();
						return;
					}
					console.log(`[DL] ${remaining.length} chunks missing, retrying in 10s`);
					this.peers.clear();
					this.failedPeers.clear();
					this.lastExhaustedTime = Date.now();
					setTimeout(() => { if (this.state === 'downloading' && !this.paused) this.doWork().catch(() => {}); }, 10000);
					return;
				}
			}
		});
	}

	// Max download speed in bytes/sec (0 = unlimited). Set via setMaxDownloadSpeed().
	private static maxBytesPerSec = 0;

	static setMaxDownloadSpeed(kbPerSec: number): void { Downloader.maxBytesPerSec = Math.max(0, kbPerSec) * 1024; }

	private async downloadChunks(): Promise<void> {
		const missingChunks = this.dataServer.getMissingChunks(this.lishID);
		const allChunks = this.dataServer.getAllChunkCount(this.lishID);
		const totalChunks = allChunks > 0 ? allChunks : missingChunks.length;
		this.downloadStartTime = Date.now();
		this.downloadedBytes = 0;
		let downloadedCount = totalChunks - missingChunks.length;

		if (this.peers.size === 0) return;

		// Shared queue — peers pull chunks concurrently
		const queue = [...missingChunks];
		let queueIdx = 0;
		const lock = new Mutex();
		const activePeerLoops = new Set<string>();
		// Track all peerLoop promises so we can await dynamically spawned ones
		const peerLoopPromises = new Map<string, Promise<void>>();

		const servingPeers = new Set<string>(); // peers that actually served at least 1 chunk

		const spawnNewPeerLoops = (): void => {
			for (const [pid, cli] of this.peers) {
				if (!activePeerLoops.has(pid)) {
					console.log(`[DL] Peer ${pid.slice(0, 12)} joined (total: ${this.peers.size})`);
					const p = peerLoop(pid, cli).catch(() => {});
					peerLoopPromises.set(pid, p);
				}
			}
		};

		const peerLoop = async (peerID: string, client: LISHClient): Promise<void> => {
			activePeerLoops.add(peerID);
			let skippedChunks = 0;
			while (true) {
				await this.waitIfPaused();
				let chunk: MissingChunk | undefined;
				await lock.runExclusive(() => {
					if (queueIdx < queue.length) chunk = queue[queueIdx++];
				});
				if (!chunk) break;

				const result = await this.downloadChunk(client, chunk.chunkID);
				if (result === 'error') {
					console.log(`[DL] Peer ${peerID.slice(0, 12)} disconnected`);
					this.peers.delete(peerID);
					this.failedPeers.add(peerID);
					servingPeers.delete(peerID);
					await client.close().catch(() => {});
					await lock.runExclusive(() => { queue.push(chunk!); });
					// Spawn loops for any newly discovered peers before exiting
					spawnNewPeerLoops();
					break;
				}
				if (result === 'not_available') {
					await lock.runExclusive(() => { queue.push(chunk!); });
					skippedChunks++;
					spawnNewPeerLoops();
					if (skippedChunks > missingChunks.length) {
						servingPeers.delete(peerID);
						break;
					}
					continue;
				}
				// Success — write chunk
				skippedChunks = 0;
				servingPeers.add(peerID);
				const data = result.data;
				await this.dataServer.writeChunk(this.downloadDir, this.lish, chunk.fileIndex, chunk.chunkIndex, data);
				this.dataServer.markChunkDownloaded(this.lishID, chunk.chunkID);
				downloadedCount++;
				this.downloadedBytes += data.length;
				// Rolling speed average (~10 second window)
				const now = Date.now();
				this.speedSamples.push({ time: now, bytes: data.length });
				const cutoff = now - 10000;
				this.speedSamples = this.speedSamples.filter(s => s.time > cutoff);
				const windowBytes = this.speedSamples.reduce((sum, s) => sum + s.bytes, 0);
				const elapsed = (now - this.downloadStartTime) / 1000;
				const windowSec = this.speedSamples.length > 1
					? (now - this.speedSamples[0]!.time) / 1000
					: elapsed;
				const bytesPerSecond = windowSec > 0.1 ? Math.round(windowBytes / windowSec) : 0;
				this.lastServingPeerCount = servingPeers.size;
				if (downloadedCount % 50 === 0 || downloadedCount === totalChunks) {
					console.log(`[DL] ${downloadedCount}/${totalChunks} chunks, ${servingPeers.size} peers, ${Math.round(bytesPerSecond / 1024)}KB/s`);
				}
				this.onProgress?.({ downloadedChunks: downloadedCount, totalChunks, peers: servingPeers.size, bytesPerSecond });
				if (Downloader.maxBytesPerSec > 0) {
					const elapsed2 = (Date.now() - this.downloadStartTime) / 1000;
					const expectedTime = this.downloadedBytes / Downloader.maxBytesPerSec;
					const waitMs = Math.max(0, (expectedTime - elapsed2) * 1000);
					if (waitMs > 10) await new Promise(r => setTimeout(r, waitMs));
				}
				// Check for newly discovered peers and spawn loops for them
				spawnNewPeerLoops();
			}
			activePeerLoops.delete(peerID);
		};

		try {
			const initialPeers = [...this.peers.entries()];
			console.log(`[DL] Starting: ${totalChunks} chunks from ${initialPeers.length} peer(s)`);
			// Start initial peer loops
			for (const [peerID, client] of initialPeers) {
				const p = peerLoop(peerID, client).catch(() => {});
				peerLoopPromises.set(peerID, p);
			}
			// Wait until all peer loops (including dynamically spawned ones) settle
			while (peerLoopPromises.size > 0) {
				const current = [...peerLoopPromises.entries()];
				await Promise.all(current.map(([, p]) => p));
				// Remove settled ones
				for (const [id] of current) peerLoopPromises.delete(id);
				// Loop back to check if new loops were spawned while we waited
			}
			if (downloadedCount < totalChunks) {
				console.log(`[DL] Peers exhausted at ${downloadedCount}/${totalChunks}, will retry`);
			}
		} finally {
			for (const [, client] of this.peers) await client.close();
			this.peers.clear();
			this.lastServingPeerCount = 0;
		}
	}

	private async callForPeers() {
		// 1. GossipSub broadcast (may not reach all peers reliably)
		const msg: PubsubMessage = { type: 'want', lishID: this.lishID };
		await this.network.broadcast(lishTopic(this.networkID), msg);
		// 2. Direct probe: try every peer on the topic via LISH protocol stream
		await this.probeTopicPeers();
		this.setupCallForPeersInterval();
	}

	private async probeTopicPeers(): Promise<void> {
		const topicPeers = this.network.getTopicPeers(this.networkID);
		let foundNew = false;
		for (const peerID of topicPeers) {
			if (this.peers.has(peerID)) continue;
			if (this.failedPeers.has(peerID)) continue;
			try {
				const probeStream = await this.network.dialProtocolByPeerId(peerID, LISH_PROTOCOL);
				const probeClient = new LISHClient(probeStream);
				const manifest = await probeClient.requestManifest(this.lishID);
				await probeClient.close();

				if (!manifest) continue;

				if (this.needsManifest && manifest.files && manifest.files.length > 0) {
					this.lish = { ...manifest, directory: this.downloadDir };
					this.dataServer.add(this.lish);
					this.onManifestImported?.(this.lishID);
					this.missingChunks = this.dataServer.getMissingChunks(this.lishID);
					this.needsManifest = false;
					this.state = 'preparing';
					console.log(`[DL] Got manifest from ${peerID.slice(0, 12)}: ${manifest.files.length} files, ${this.missingChunks.length} chunks`);
				}

				const dlStream = await this.network.dialProtocolByPeerId(peerID, LISH_PROTOCOL);
				this.peers.set(peerID, new LISHClient(dlStream));
				this.lastExhaustedTime = 0;
				foundNew = true;
				console.log(`[DL] Found peer ${peerID.slice(0, 12)} (total: ${this.peers.size})`);
			} catch {
				// peer unreachable — skip silently
			}
		}
		if (foundNew && !this.downloadActive) {
			this.doWork().then(() => {});
		}
	}

	private setupCallForPeersInterval() {
		if (this.callForPeersInterval) return;
		this.callForPeersInterval = setInterval(async () => {
			if (this.state === 'downloaded') {
				clearInterval(this.callForPeersInterval);
				this.callForPeersInterval = undefined;
				return;
			}
			if (this.state !== 'downloading' && this.state !== 'awaiting-manifest') return;
			const before = this.peers.size;
			this.failedPeers.clear();
			this.lastExhaustedTime = 0;
			await this.probeTopicPeers();
			if (!this.downloadActive && this.peers.size > before) this.doWork().catch(() => {});
		}, 15000);
	}

	private async handlePubsubMessage(topic: string, data: Record<string, any>): Promise<void> {
		if (topic !== lishTopic(this.networkID)) return;
		if (data['type'] === 'have' && data['lishID'] === this.lishID && data['chunks']) {
			if (this.peers.has(data['peerID'])) return;
			try {
				await this.connectToPeer(data as HaveMessage);
			} catch {
				return;
			}
			this.lastExhaustedTime = 0;
			if (!this.downloadActive) this.doWork().then(() => {});
		}
	}

	private async connectToPeer(data: HaveMessage): Promise<void> {
		const peerID: NodeID = data.peerID;
		const multiaddrs: Multiaddr[] = data.multiaddrs.map(ma => multiaddr(ma.toString()));
		const stream = await this.network.dialProtocol(multiaddrs, LISH_PROTOCOL);
		if (this.peers.has(data.peerID)) throw new Error(`Already connected to peer: ${peerID}`);
		this.peers.set(peerID, new LISHClient(stream));
		console.log(`[DL] Peer ${peerID.slice(0, 12)} connected via pubsub (total: ${this.peers.size})`);
	}

	// Create directory structure and initialize files
	private async createDirectoryStructure(): Promise<void> {
		if (this.lish.directories) {
			for (const dir of this.lish.directories) {
				await mkdir(join(this.downloadDir, dir.path), { recursive: true });
			}
		}
		if (this.lish.files) {
			for (const file of this.lish.files) {
				const filePath = join(this.downloadDir, file.path);
				await mkdir(dirname(filePath), { recursive: true });
				if (!(await Bun.file(filePath).exists())) {
					const fd = await open(filePath, 'w');
					const zeroChunk = new Uint8Array(1024 * 1024);
					let remaining = file.size;
					while (remaining > 0) {
						const writeSize = Math.min(remaining, zeroChunk.length);
						await fd.write(zeroChunk.slice(0, writeSize));
						remaining -= writeSize;
					}
					await fd.close();
				}
			}
		}
		console.log(`[DL] Directory structure created: ${this.lish.files?.length ?? 0} files in ${this.downloadDir}`);
	}

	// Download a single chunk from a peer using an existing client
	private async downloadChunk(client: LISHClient, chunkID: ChunkID): Promise<{ data: Uint8Array } | 'not_available' | 'error'> {
		try {
			const data = await client.requestChunk(this.lishID, chunkID);
			return data ? { data } : 'not_available';
		} catch {
			return 'error';
		}
	}
}
