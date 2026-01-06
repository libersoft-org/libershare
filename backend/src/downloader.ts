import {mkdir, readFile, open} from 'fs/promises';
import {join, dirname} from 'path';
import {existsSync} from 'fs';
import type {IManifest, LishId, ChunkId} from './lish.ts';
import type {Network} from './network.ts';
import type {Multiaddr} from '@multiformats/multiaddr';
import {HaveChunks, LISH_PROTOCOL, LishClient} from './lish-protocol.ts';
import {Mutex} from 'async-mutex';
import {DataServer, MissingChunk} from './data-server.ts';

export const LISH_TOPIC = 'lish';

type NodeId = string;

interface PubsubMessage {
    type: 'want' | 'have';
    lishId: LishId;
}

export interface WantMessage extends PubsubMessage {
    type: 'want';
}

export interface HaveMessage extends PubsubMessage {
    type: 'have';
    peerId: NodeId;
    multiaddrs: Multiaddr[];
    chunks: HaveChunks
}


type State = 'added' | 'initializing' | 'initialized' | 'preparing' | 'downloading' | 'downloaded';

export class Downloader {
    private manifest!: IManifest;
    private readonly dataServer: DataServer;
    private network: Network;
    private readonly downloadDir: string;
    private lishId!: LishId;
    private state: State = 'added';
    private workMutex = new Mutex();
    private doMoreWork: boolean = false;
    private missingChunks: MissingChunk[] = [];
    private peers: Map<NodeId, LishClient> = new Map();
    private callForPeersInterval: NodeJS.Timeout | undefined;


    constructor(downloadDir: string, network: Network, dataServer: DataServer) {
        this.downloadDir = downloadDir;
        this.network = network;
        this.dataServer = dataServer;
    }

    async init(manifestPath: string): Promise<void> {
        this.state = 'initializing';

        // Read and parse manifest
        const content = await readFile(manifestPath, 'utf-8');
        this.manifest = JSON.parse(content);
        this.lishId = this.manifest.id as LishId;

        console.log(`Loading manifest: ${this.manifest.name} (id: ${this.lishId})`);

        this.missingChunks = this.dataServer.getMissingChunks(this.manifest);
        console.log(`Found ${this.missingChunks.length} chunks to download`);
        await this.network.subscribe(LISH_TOPIC, async (data) => {
            await this.handlePubsubMessage(LISH_TOPIC, data)
        });
        this.state = 'initialized';
    }


    // Main download loop
    async download(): Promise<void> {
        console.log('Starting download...');
        if (this.state !== 'initialized') {
            throw new Error('Downloader not initialized');
        }
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

            if (this.doMoreWork) {
                this.doWork().then(r => {
                });
            }

        })
    }


    private async downloadChunks(): Promise<void> {
        let downloadedCount = 0;
        let missingChunks = this.dataServer.getMissingChunks(this.manifest)
        try {
            // Download loop - reuse the open streams
            for (const chunk of missingChunks) {
                let downloaded = false;

                // Try each peer client until one succeeds
                for (const [peerId, client] of this.peers) {
                    const data = await this.downloadChunk(client, chunk.chunkId);

                    if (data) {
                        // Write chunk to file at correct offset
                        await this.dataServer.writeChunk(this.manifest, chunk.fileIndex, chunk.chunkIndex, data);

                        // Mark as downloaded
                        this.dataServer.markChunkDownloaded(this.lishId, chunk.chunkId);

                        downloadedCount++;
                        console.log(`✓ Downloaded chunk ${downloadedCount}/${missingChunks.length}`);
                        break;
                    }
                }
            }
            console.log(`✓ Download complete! Downloaded ${downloadedCount}/${missingChunks.length} chunks`);
        } finally {
            for (const [peerId, client] of this.peers) {
                await client.close();
            }
        }
    }


    private async callForPeers() {
        const msg: PubsubMessage = {type: 'want', lishId: this.lishId};
        await this.network.broadcast(LISH_TOPIC, msg);
        this.setupCallForPeersInterval();
    }


    private setupCallForPeersInterval() {
        if (this.callForPeersInterval)
            return;
        this.callForPeersInterval = setInterval(async () => {

            if (this.state === 'downloaded') {
                clearInterval(this.callForPeersInterval);
                this.callForPeersInterval = undefined;
                return;
            }

            if (this.state !== 'downloading') {
                return;
            }

            if (this.peers.size === 0) {
                console.log('No seeders available');
                await this.callForPeers();
            }
        }, 60000);
    }


    private async handlePubsubMessage(topic: string, data: any) {
        console.log(`Received pubsub message on topic ${LISH_TOPIC}`);

        if (topic != LISH_TOPIC)
            return;

        console.debug(data); // with peerId etc.
        if (data.type == 'have' && data.lishId == this.lishId) {
            if (data.chunks === 'all' /* || this.peerHasAnyMissingChunks(data.chunks)*/) {
                if (this.peers.has(data.peerId)) {
                    console.log(`Already connected to peer ...${data.peerId}`);
                } else {
                    console.log(`Peer ...${data.peerId} has the file, connecting...`);
                    try {
                        await this.connectToPeer(data)
                    } catch (error) {
                        console.log(`✗ Failed to connect to peer ...${data.peerId}:`, error instanceof Error ? error.message : error);
                        return;
                    }
                    this.doWork().then(r => {
                    });
                }
            }
        }
    }

    private async connectToPeer(data: HaveMessage) {
        const peerId: NodeId = data.peerId;
        const multiaddrs: Multiaddr[] = data.multiaddrs;
        const chunks: HaveChunks = data.chunks;

        try {
            console.log(`Opening stream to peer ...${peerId}`);
            const stream = await this.network.dialProtocol(peerId, multiaddrs, LISH_PROTOCOL);
            if (this.peers.has(data.peerId)) {
                throw new Error(`Already connected to peer ...${peerId}`);
            }
            this.peers.set(peerId, new LishClient(stream));
        } catch (error) {
            console.log(`✗ Failed to connect to peer ...${peerId}:`, error instanceof Error ? error.message : error);
        }
    }



    // Create directory structure and initialize files
    private async createDirectoryStructure(): Promise<void> {
        console.log('Creating directory structure...');

        // Create directories
        if (this.manifest.directories) {
            for (const dir of this.manifest.directories) {
                const dirPath = join(this.downloadDir, dir.path);
                await mkdir(dirPath, {recursive: true});
                console.log(`  Created directory: ${dir.path}`);
            }
        }

        // Create files filled with zeros
        if (this.manifest.files) {
            for (const file of this.manifest.files) {
                const filePath = join(this.downloadDir, file.path);

                // Create parent directory if needed
                const fileDir = dirname(filePath);
                await mkdir(fileDir, {recursive: true});

                // Check if file already exists
                if (!existsSync(filePath)) {
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
                } else {
                    console.log(`  File already exists: ${file.path}`);
                }
            }
        }

        console.log('✓ Directory structure and files created');
    }

    // Download a single chunk from a peer using an existing client
    private async downloadChunk(client: LishClient, chunkId: ChunkId): Promise<Uint8Array | null> {
        try {
            // Request the chunk using the protocol
            const data = await client.requestChunk(this.lishId, chunkId);

            if (data) {
                console.log(`✓ Received chunk ${chunkId.slice(0, 8)}... (${data.length} bytes)`);
            } else {
                console.log(`✗ Peer did not have chunk ${chunkId.slice(0, 8)}...`);
            }

            return data;
        } catch (error) {
            console.log(`✗ Failed to download chunk ${chunkId.slice(0, 8)}...:`, error instanceof Error ? error.message : error);
            return null;
        }
    }

}
