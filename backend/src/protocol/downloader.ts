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
	private failedPeers = new Set<NodeID>(); // peers that failed — don't re-probe until next cycle
	private callForPeersInterval: NodeJS.Timeout | undefined;
	private needsManifest = false;
	private paused = false;
	private pauseResolve?: () => void;
	private downloadResolve?: () => void;
	private downloadReject?: (err: Error) => void;
	private onProgress?: (info: { downloadedChunks: number; totalChunks: number; peers: number; bytesPerSecond: number }) => void;
	private onManifestImported?: (lishID: string) => void;
	private downloadStartTime = 0;
	private downloadedBytes = 0;
	private speedSamples: { time: number; bytes: number }[] = [];

	getLISHID(): string { return this.lishID; }

	setProgressCallback(cb: (info: { downloadedChunks: number; totalChunks: number; peers: number; bytesPerSecond: number }) => void): void {
		this.onProgress = cb;
	}

	setManifestImportedCallback(cb: (lishID: string) => void): void {
		this.onManifestImported = cb;
	}

	pause(): void {
		this.paused = true;
		console.log(`[Downloader] Paused: ${this.lishID}`);
	}

	resume(): void {
		this.paused = false;
		console.log(`[Downloader] Resumed: ${this.lishID}`);
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
		console.log(`Loading LISH: ${this.lish.name} (id: ${this.lishID})`);
		this.missingChunks = this.dataServer.getMissingChunks(this.lishID);
		console.log(`Found ${this.missingChunks.length} chunks to download`);
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
		console.log(`Loading LISH from catalog: ${this.lish.name} (id: ${this.lishID})`);
		// Check if we already have the full manifest in DB
		const existingChunks = this.dataServer.getMissingChunks(this.lishID);
		if (existingChunks.length > 0 || this.dataServer.isCompleteLISH(lish)) {
			// We have the manifest — proceed normally
			this.missingChunks = existingChunks;
			console.log(`Found ${this.missingChunks.length} chunks to download`);
		} else {
			// Stub manifest — need to fetch full manifest from a peer first
			this.needsManifest = true;
			console.log(`Stub manifest — will request full manifest from peer`);
		}
		const topic = lishTopic(this.networkID);
		await this.network.subscribe(topic, async data => {
			await this.handlePubsubMessage(topic, data);
		});
		this.state = 'initialized';
	}

	// Main download loop — returns only when fully downloaded (or throws on error)
	async download(): Promise<void> {
		console.log('Starting download...');
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
		await this.workMutex.runExclusive(async () => {
			// Phase 1: fetch manifest from a peer if needed
			if (this.state === 'awaiting-manifest') {
				if (this.peers.size === 0) {
					console.log('Waiting for peers to provide manifest...');
					return;
				}
				// Try to get manifest from a connected peer
				for (const [peerID, client] of this.peers) {
					console.log(`Requesting manifest from peer ...${peerID}`);
					const manifest = await client.requestManifest(this.lishID);
					if (manifest && manifest.files && manifest.files.length > 0) {
						console.log(`✓ Got manifest from peer: ${manifest.files.length} files`);
						this.lish = { ...manifest, directory: this.downloadDir };
						// Import into dataServer so getMissingChunks works
						this.dataServer.add(this.lish);
						this.onManifestImported?.(this.lishID);
						this.missingChunks = this.dataServer.getMissingChunks(this.lishID);
						this.needsManifest = false;
						console.log(`Found ${this.missingChunks.length} chunks to download`);
						this.state = 'preparing';
						break;
					} else {
						console.log(`✗ Peer ...${peerID} did not have manifest`);
					}
				}
				if (this.needsManifest) return; // still waiting
			}
			// Phase 2: create directory structure
			if (this.state === 'preparing') {
				await this.createDirectoryStructure();
				this.state = 'downloading';
			}
			// Phase 3: download chunks
			if (this.state === 'downloading') {
				if (this.missingChunks.length === 0) {
					console.log('✓ All chunks downloaded!');
					this.state = 'downloaded';
					this.downloadResolve?.();
					return;
				}
				if (this.peers.size === 0) {
					console.log('Need to find peers');
					await this.callForPeers();
					return;
				}
				if (this.peers.size !== 0) {
					console.log(`Found ${this.peers.size} peers with the file`);
					await this.downloadChunks();
					// After downloadChunks, check if complete
					const remaining = this.dataServer.getMissingChunks(this.lishID);
					if (remaining.length === 0) {
						console.log('✓ All chunks downloaded!');
						this.state = 'downloaded';
						this.downloadResolve?.();
						return;
					}
					// Not complete — peers exhausted, re-probe after delay
					console.log(`${remaining.length} chunks still missing, will re-probe peers in 10s`);
					this.peers.clear();
					this.failedPeers.clear(); // allow re-probe of previously failed peers
					setTimeout(() => { if (this.state === 'downloading') this.doWork().catch(() => {}); }, 10000);
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

		// Build peer list for parallel download
		if (this.peers.size === 0) {
			console.log('No peers available for download');
			return;
		}

		// Shared queue — peers pull chunks concurrently
		const queue = [...missingChunks];
		let queueIdx = 0;
		const lock = new Mutex();
		const activePeerLoops = new Set<string>();

		const servingPeers = new Set<string>(); // peers that actually served at least 1 chunk
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
					// Stream error — peer is dead, remove and exit loop
					console.log(`✗ Peer ${peerID.slice(0, 12)} stream error, removing peer`);
					this.peers.delete(peerID);
					this.failedPeers.add(peerID);
					servingPeers.delete(peerID);
					await client.close().catch(() => {});
					await lock.runExclusive(() => { queue.push(chunk!); });
					break;
				}
				if (result === 'not_available') {
					// Peer doesn't have this chunk — requeue and try next
					await lock.runExclusive(() => { queue.push(chunk!); });
					skippedChunks++;
					if (skippedChunks > missingChunks.length) {
						// Exhausted all chunks this peer could serve
						console.log(`✗ Peer ${peerID.slice(0, 12)} has no more chunks we need`);
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
				console.log(`✓ Downloaded chunk ${downloadedCount}/${totalChunks} (peer ${peerID.slice(0, 12)}, serving=${servingPeers.size})`);
				this.onProgress?.({ downloadedChunks: downloadedCount, totalChunks, peers: servingPeers.size, bytesPerSecond });
				if (Downloader.maxBytesPerSec > 0) {
					const elapsed2 = (Date.now() - this.downloadStartTime) / 1000;
					const expectedTime = this.downloadedBytes / Downloader.maxBytesPerSec;
					const waitMs = Math.max(0, (expectedTime - elapsed2) * 1000);
					if (waitMs > 10) await new Promise(r => setTimeout(r, waitMs));
				}
				// Check for newly discovered peers and spawn loops for them
				for (const [newPeerID, newClient] of this.peers) {
					if (!activePeerLoops.has(newPeerID)) {
						console.log(`🔗 New peer ${newPeerID.slice(0, 12)} joined download`);
						peerLoop(newPeerID, newClient).catch(() => {});
					}
				}
			}
			activePeerLoops.delete(peerID);
		};

		try {
			const initialPeers = [...this.peers.entries()];
			console.log(`Starting parallel download from ${initialPeers.length} peer(s), ${totalChunks} chunks`);
			await Promise.all(initialPeers.map(([peerID, client]) => peerLoop(peerID, client)));
			if (downloadedCount >= totalChunks) {
				console.log(`✓ Download complete! Downloaded ${downloadedCount}/${totalChunks} chunks`);
			} else {
				console.log(`⚠ All peers exhausted. Downloaded ${downloadedCount}/${totalChunks} chunks. Will retry when peers reconnect.`);
				// Send progress with 0 peers so frontend updates counters
				this.onProgress?.({ downloadedChunks: downloadedCount, totalChunks, peers: 0, bytesPerSecond: 0 });
			}
		} finally {
			for (const [, client] of this.peers) await client.close();
			this.peers.clear();
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
		for (const peerID of topicPeers) {
			if (this.peers.has(peerID)) continue;
			if (this.failedPeers.has(peerID)) { console.log(`[Probe] Skipping failed peer ${peerID.slice(0, 12)}`); continue; }
			try {
				console.log(`[Probe] Trying direct connection to peer ${peerID.slice(0, 12)}...`);
				// Stream 1: manifest probe (will be closed after)
				const probeStream = await this.network.dialProtocolByPeerId(peerID, LISH_PROTOCOL);
				const probeClient = new LISHClient(probeStream);
				const manifest = await probeClient.requestManifest(this.lishID);
				await probeClient.close();

				if (!manifest) continue;

				console.log(`[Probe] ✓ Peer ${peerID.slice(0, 20)} has the file!`);
				// If we needed manifest, import it now
				if (this.needsManifest && manifest.files && manifest.files.length > 0) {
					this.lish = { ...manifest, directory: this.downloadDir };
					this.dataServer.add(this.lish);
					this.onManifestImported?.(this.lishID);
					this.missingChunks = this.dataServer.getMissingChunks(this.lishID);
					this.needsManifest = false;
					this.state = 'preparing';
					console.log(`[Probe] ✓ Got manifest: ${manifest.files.length} files, ${this.missingChunks.length} chunks to download`);
				}

				// Stream 2: fresh stream for chunk download (separate from manifest probe)
				const dlStream = await this.network.dialProtocolByPeerId(peerID, LISH_PROTOCOL);
				this.peers.set(peerID, new LISHClient(dlStream));

				this.doWork().then(() => {});
				return; // Found a peer, start downloading
			} catch (err) {
				console.log(`[Probe] ✗ Peer ${peerID.slice(0, 20)}: ${(err as Error).message}`);
			}
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
			if (this.peers.size === 0) {
				console.log('No seeders available');
				await this.callForPeers();
			}
		}, 60000);
	}

	private async handlePubsubMessage(topic: string, data: Record<string, any>): Promise<void> {
		const expectedTopic = lishTopic(this.networkID);
		console.log(`Received pubsub message on topic ${topic}`);

		if (topic != expectedTopic) return;

		console.debug(data); // with peerID etc.
		if (data['type'] == 'have' && data['lishID'] == this.lishID) {
			if (data['chunks'] === 'all' /* || this.peerHasAnyMissingChunks(data.chunks)*/) {
				if (this.peers.has(data['peerID'])) console.log(`Already connected to peer ...${data['peerID']}`);
				else {
					console.log(`Peer ...${data['peerID']} has the file, connecting...`);
					try {
						await this.connectToPeer(data as HaveMessage);
					} catch (error) {
						console.log(`✗ Failed to connect to peer ...${data['peerID']}:`, error instanceof Error ? error.message : error);
						return;
					}
					this.doWork().then(() => {});
				}
			}
		}
	}

	private async connectToPeer(data: HaveMessage): Promise<void> {
		const peerID: NodeID = data.peerID;
		// Convert from JSON strings back to Multiaddr instances
		const multiaddrs: Multiaddr[] = data.multiaddrs.map(ma => multiaddr(ma.toString()));
		try {
			console.log(`Opening stream to peer ...${peerID}`);
			const stream = await this.network.dialProtocol(multiaddrs, LISH_PROTOCOL);
			if (this.peers.has(data.peerID)) throw new Error(`Already connected to peer: ${peerID}`);
			this.peers.set(peerID, new LISHClient(stream));
		} catch (error) {
			console.log(`✗ Failed to connect to peer ...${peerID}:`, error instanceof Error ? error.message : error);
		}
	}

	// Create directory structure and initialize files
	private async createDirectoryStructure(): Promise<void> {
		console.log('Creating directory structure in ', this.downloadDir);
		// Create directories
		if (this.lish.directories) {
			for (const dir of this.lish.directories) {
				const dirPath = join(this.downloadDir, dir.path);
				await mkdir(dirPath, { recursive: true });
				console.log(`  Created directory: ${dir.path}`);
			}
		}
		// Create files filled with zeros
		if (this.lish.files) {
			for (const file of this.lish.files) {
				const filePath = join(this.downloadDir, file.path);
				// Create parent directory if needed
				const fileDir = dirname(filePath);
				await mkdir(fileDir, { recursive: true });
				// Check if file already exists
				if (!(await Bun.file(filePath).exists())) {
					// Create file with zeros
					const fd = await open(filePath, 'w');
					// Write zeros in chunks to avoid memory issues with large files
					const zeroChunk = new Uint8Array(1024 * 1024); // 1MB at a time
					let remaining = file.size;
					while (remaining > 0) {
						const writeSize = Math.min(remaining, zeroChunk.length);
						await fd.write(zeroChunk.slice(0, writeSize));
						remaining -= writeSize;
					}
					await fd.close();
					console.log(`  Created file: ${file.path} (${file.size} bytes)`);
				} else console.log(`  File already exists: ${file.path}`);
			}
		}
		console.log('✓ Directory structure and files created');
	}

	// Download a single chunk from a peer using an existing client
	private async downloadChunk(client: LISHClient, chunkID: ChunkID): Promise<{ data: Uint8Array } | 'not_available' | 'error'> {
		try {
			const data = await client.requestChunk(this.lishID, chunkID);
			if (data) {
				console.log(`✓ Received chunk ${chunkID.slice(0, 8)}... (${data.length} bytes)`);
				return { data };
			}
			console.log(`✗ Peer did not have chunk ${chunkID.slice(0, 8)}...`);
			return 'not_available';
		} catch (error) {
			console.log(`✗ Failed to download chunk ${chunkID.slice(0, 8)}...:`, error instanceof Error ? error.message : error);
			return 'error';
		}
	}
}
