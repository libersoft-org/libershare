import { mkdir, open } from 'fs/promises';
import { join, dirname } from 'path';
import { type IStoredLISH, type LISHid, type ChunkID } from '@shared';
import { type Network } from './network.ts';
import { lishTopic } from './constants.ts';
import { Utils } from '../utils.ts';
import { multiaddr, type Multiaddr } from '@multiformats/multiaddr';
import { type HaveChunks, LISH_PROTOCOL, LISHClient } from './lish-protocol.ts';
import { Mutex } from 'async-mutex';
import { DataServer, type MissingChunk } from '../lish/data-server.ts';

type NodeId = string;
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
	peerID: NodeId;
	multiaddrs: Multiaddr[];
	chunks: HaveChunks;
}
type State = 'added' | 'initializing' | 'initialized' | 'preparing' | 'downloading' | 'downloaded';

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
	private peers: Map<NodeId, LISHClient> = new Map();
	private callForPeersInterval: NodeJS.Timeout | undefined;

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
		this.lish = Utils.safeJsonParse(content, `LISH file: ${lishPath}`);
		this.lishID = this.lish.id as LISHid;
		console.log(`Loading LISH: ${this.lish.name} (id: ${this.lishID})`);
		this.missingChunks = this.dataServer.getMissingChunks(this.lish);
		console.log(`Found ${this.missingChunks.length} chunks to download`);
		const topic = lishTopic(this.networkID);
		await this.network.subscribe(topic, async data => {
			await this.handlePubsubMessage(topic, data);
		});
		this.state = 'initialized';
	}

	// Main download loop
	async download(): Promise<void> {
		console.log('Starting download...');
		if (this.state !== 'initialized') throw new Error('Downloader not initialized');
		this.state = 'preparing';
		await this.doWork();
	}

	async doWork(): Promise<void> {
		await this.workMutex.runExclusive(async () => {
			if (this.state === 'preparing') {
				await this.createDirectoryStructure();
				this.state = 'downloading';
			}
			if (this.state === 'downloading') {
				if (this.missingChunks.length === 0) {
					console.log('✓ All chunks downloaded!');
					this.state = 'downloaded';
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
				}
			}
		});
	}

	private async downloadChunks(): Promise<void> {
		let downloadedCount = 0;
		let missingChunks = this.dataServer.getMissingChunks(this.lish);
		try {
			// Download loop - reuse the open streams
			for (const chunk of missingChunks) {
				let downloaded = false;
				// Try each peer client until one succeeds
				for (const [, client] of this.peers) {
					const data = await this.downloadChunk(client, chunk.chunkID);
					if (data) {
						// Write chunk to file at correct offset
						await this.dataServer.writeChunk(this.downloadDir, this.lish, chunk.fileIndex, chunk.chunkIndex, data);
						// Mark as downloaded
						await this.dataServer.markChunkDownloaded(this.lishID, chunk.chunkID);
						downloadedCount++;
						downloaded = true;
						console.log(`✓ Downloaded chunk ${downloadedCount}/${missingChunks.length}`);
						break;
					}
				}
				if (!downloaded) {
					console.log(`✗ No peer had chunk ${chunk.chunkID.slice(0, 8)}...`);
				}
			}
			console.log(`✓ Download complete! Downloaded ${downloadedCount}/${missingChunks.length} chunks`);
		} finally {
			for (const [, client] of this.peers) {
				await client.close();
			}
			this.peers.clear();
		}
	}

	private async callForPeers() {
		const msg: PubsubMessage = { type: 'want', lishID: this.lishID };
		await this.network.broadcast(lishTopic(this.networkID), msg);
		this.setupCallForPeersInterval();
	}

	private setupCallForPeersInterval() {
		if (this.callForPeersInterval) return;
		this.callForPeersInterval = setInterval(async () => {
			if (this.state === 'downloaded') {
				clearInterval(this.callForPeersInterval);
				this.callForPeersInterval = undefined;
				return;
			}
			if (this.state !== 'downloading') return;
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
				if (this.peers.has(data['peerID'])) {
					console.log(`Already connected to peer ...${data['peerID']}`);
				} else {
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
		const peerID: NodeId = data.peerID;
		// Convert from JSON strings back to Multiaddr instances
		const multiaddrs: Multiaddr[] = data.multiaddrs.map(ma => multiaddr(ma.toString()));
		try {
			console.log(`Opening stream to peer ...${peerID}`);
			const stream = await this.network.dialProtocol(multiaddrs, LISH_PROTOCOL);
			if (this.peers.has(data.peerID)) throw new Error(`Already connected to peer ...${peerID}`);
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
	private async downloadChunk(client: LISHClient, chunkID: ChunkID): Promise<Uint8Array | null> {
		try {
			// Request the chunk using the protocol
			const data = await client.requestChunk(this.lishID, chunkID);
			if (data) console.log(`✓ Received chunk ${chunkID.slice(0, 8)}... (${data.length} bytes)`);
			else console.log(`✗ Peer did not have chunk ${chunkID.slice(0, 8)}...`);
			return data;
		} catch (error) {
			console.log(`✗ Failed to download chunk ${chunkID.slice(0, 8)}...:`, error instanceof Error ? error.message : error);
			return null;
		}
	}
}
