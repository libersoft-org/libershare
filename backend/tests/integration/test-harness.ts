import { Subprocess } from 'bun';

const DEFAULT_API_PORT = 1158;

interface ServerOptions {
	port?: number;
	dataDir: string;
	name?: string;
	enablePink?: boolean;
	debug?: boolean;
}


export class TestServer {
	private process: Subprocess | null = null;
	private _client: ApiClient | null = null;
	readonly port: number;
	readonly dataDir: string;
	readonly apiUrl: string;

	constructor(private options: ServerOptions) {
		this.port = options.port ?? DEFAULT_API_PORT;
		this.dataDir = options.dataDir;
		this.apiUrl = `ws://localhost:${this.port}`;
	}

	get client(): ApiClient {
		if (!this._client) {
			throw new Error('Server not started');
		}
		return this._client;
	}

	async start(): Promise<void> {
		// Ensure dataDir exists
		await Bun.$`mkdir -p ${this.dataDir}`;

		// Write settings.json with port 0 (OS-assigned) for network
		const settings = {
			network: { port: 0, bootstrapPeers: [] },
			relay: { server: { enabled: false } },
		};
		await Bun.write(`${this.dataDir}/settings.json`, JSON.stringify(settings));

		// Build command args
		const args = ['run', 'src/app.ts', '--datadir', this.dataDir];
		if (this.options.enablePink) {
			args.push('--pink');
		}

		// Set env variables
		const env = {
			...process.env,
			API_PORT: String(this.port),
			...(this.options.name && { LOG_PREFIX: this.options.name }),
		};

		// Go up from tests/ to backend/
		const backendDir = import.meta.dir.replace(/\/tests$/, '');
		const stdio = this.options.debug ? 'inherit' : 'pipe';

		this.process = Bun.spawn(['bun', ...args], {
			cwd: backendDir,
			env,
			stdout: stdio,
			stderr: stdio,
		});

		// Wait for server to be ready
		await this.waitForReady();

		// Create and connect client
		this._client = new ApiClient(this.apiUrl);
		await this._client.connect();
	}

	private async waitForReady(timeout = 10000): Promise<void> {
		const start = Date.now();

		while (Date.now() - start < timeout) {
			try {
				const ws = new WebSocket(this.apiUrl);
				await new Promise<void>((resolve, reject) => {
					ws.onopen = () => {
						ws.close();
						resolve();
					};
					ws.onerror = reject;
				});
				return;
			} catch {
				await Bun.sleep(100);
			}
		}

		throw new Error(`Server failed to start within ${timeout}ms`);
	}

	async call<T = any>(method: string, params?: Record<string, any>): Promise<T> {
		return this.client.call<T>(method, params);
	}

	on(event: string, handler: (data: any) => void): void {
		this.client.on(event, handler);
	}

	async stop(): Promise<void> {
		if (this._client) {
			this._client.close();
			this._client = null;
		}

		if (this.process) {
			this.process.kill();
			await this.process.exited;
			this.process = null;
		}
	}

	async cleanup(): Promise<void> {
		await this.stop();
		// Optionally remove dataDir
		await Bun.$`rm -rf ${this.dataDir}`.quiet();
	}
}

async function findFreePort(): Promise<number> {
	const server = Bun.serve({ port: 0, fetch: () => new Response() });
	const port = server.port;
	server.stop(true);
	return port;
}

export class TestHarness {
	private servers = new Map<string, TestServer>();
	private runId = crypto.randomUUID().slice(0, 8);
	debug = false;

	async createServer(name: string, options?: Partial<ServerOptions>): Promise<TestServer> {
		if (this.servers.has(name)) {
			throw new Error(`Server '${name}' already exists`);
		}

		const port = options?.port ?? await findFreePort();
		const dataDir = options?.dataDir ?? `/tmp/libershare-test-${this.runId}/${name}`;

		const server = new TestServer({
			port,
			dataDir,
			name,
			enablePink: options?.enablePink,
			debug: options?.debug ?? this.debug,
		});

		await server.start();
		this.servers.set(name, server);

		return server;
	}

	getServer(name: string): TestServer {
		const server = this.servers.get(name);
		if (!server) {
			throw new Error(`Server '${name}' not found`);
		}
		return server;
	}

	async stopServer(name: string): Promise<void> {
		const server = this.servers.get(name);
		if (server) {
			await server.stop();
			this.servers.delete(name);
		}
	}

	async stopAll(): Promise<void> {
		const stops = Array.from(this.servers.values()).map(s => s.stop());
		await Promise.all(stops);
		this.servers.clear();
	}

	async cleanupAll(): Promise<void> {
		const cleanups = Array.from(this.servers.values()).map(s => s.cleanup());
		await Promise.all(cleanups);
		this.servers.clear();
	}
}

// Example usage / simple test runner
if (import.meta.main) {
	const harness = new TestHarness();

	try {
		console.log('Creating test servers...');

		const server1 = await harness.createServer('node1');
		const server2 = await harness.createServer('node2');

		console.log(`Server 1: ${server1.apiUrl} (${server1.dataDir})`);
		console.log(`Server 2: ${server2.apiUrl} (${server2.dataDir})`);

		// Test basic API call
		const networks1 = await server1.call('networks.list');
		console.log('Server 1 networks:', networks1);

		const networks2 = await server2.call('networks.list');
		console.log('Server 2 networks:', networks2);

		console.log('Tests passed!');
	} catch (error) {
		console.error('Test failed:', error);
	} finally {
		await harness.cleanupAll();
	}
}
