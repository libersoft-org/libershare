import { TestHarness } from './test-harness.ts';
import { generateKey } from '@libp2p/pnet';
import type { ILISHNetwork } from '../src/makenet.ts';
import { join } from 'path';

const NODE_COUNT = 3;

interface TestNetwork {
	definition: ILISHNetwork;
	swarmKeyBytes: Uint8Array;
}

async function createTestNetwork(name: string, bootstrapPeers: string[] = []): Promise<TestNetwork> {
	const swarmKeyBytes = new Uint8Array(95);
	await generateKey(swarmKeyBytes);

	return {
		definition: {
			version: 1,
			networkID: crypto.randomUUID(),
			swarmKey: swarmKeyBytes.toBase64(),
			name,
			description: `Test network for data transfer`,
			bootstrapPeers,
			created: new Date().toISOString(),
		},
		swarmKeyBytes,
	};
}

async function writeNetworkFile(network: ILISHNetwork, path: string): Promise<void> {
	await Bun.write(path, JSON.stringify(network, null, '\t'));
}

function assert(condition: boolean, message: string): asserts condition {
	if (!condition) {
		throw new Error(`Assertion failed: ${message}`);
	}
}

async function waitForCondition(
	check: () => Promise<boolean>,
	timeoutMs: number,
	intervalMs: number = 500
): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (await check()) return true;
		await Bun.sleep(intervalMs);
	}
	return false;
}

// Generate random bytes
function randomBytes(size: number): Uint8Array {
	const bytes = new Uint8Array(size);
	crypto.getRandomValues(bytes);
	return bytes;
}

// Create a test directory with random files
async function createTestDataDir(baseDir: string): Promise<{ dir: string; files: Map<string, Uint8Array> }> {
	const dir = join(baseDir, `test-data-${crypto.randomUUID().slice(0, 8)}`);
	await Bun.$`mkdir -p ${dir}`;

	const files = new Map<string, Uint8Array>();

	// Create a few files of varying sizes
	const fileSpecs = [
		{ name: 'small.txt', size: 100 },
		{ name: 'medium.bin', size: 10_000 },
		{ name: 'larger.dat', size: 100_000 },
		{ name: 'subdir/nested.txt', size: 500 },
	];

	for (const spec of fileSpecs) {
		const filePath = join(dir, spec.name);
		const content = randomBytes(spec.size);

		// Ensure parent directory exists
		const parentDir = filePath.substring(0, filePath.lastIndexOf('/'));
		await Bun.$`mkdir -p ${parentDir}`;

		await Bun.write(filePath, content);
		files.set(spec.name, content);
	}

	return { dir, files };
}

async function main() {
	const harness = new TestHarness();
	harness.debug = true;

	const networkFile = `/tmp/test-network-transfer-${Date.now()}.lishnet`;
	let testDataDir: string | null = null;

	try {
		console.log(`\n${'='.repeat(60)}`);
		console.log(`Creating ${NODE_COUNT} test nodes...`);
		console.log('='.repeat(60));

		const serverPromises = Array.from({ length: NODE_COUNT }, (_, i) =>
			harness.createServer(`node${i}`)
		);
		const servers = await Promise.all(serverPromises);

		console.log('\nNodes created:');
		for (const server of servers) {
			console.log(`  - ${server.apiUrl} (${server.dataDir})`);
		}

		// Create and setup network
		console.log(`\n${'='.repeat(60)}`);
		console.log('Setting up network...');
		console.log('='.repeat(60));

		const network = await createTestNetwork('TestNet-Transfer');
		await writeNetworkFile(network.definition, networkFile);
		console.log(`  Network ID: ${network.definition.networkID}`);

		// Import and enable on node 0 (bootstrap/seeder)
		await servers[0].call('networks.import', { path: networkFile, enabled: true });
		await Bun.sleep(2000);

		const node0Info = await servers[0].call('getNodeInfo', { networkId: network.definition.networkID });
		const bootstrapAddr = node0Info.addresses.find((a: string) =>
			a.includes('/tcp/') && !a.includes('127.0.0.1') && !a.includes('/p2p-circuit/')
		) || node0Info.addresses[0];
		console.log(`  Bootstrap: ${bootstrapAddr}`);

		// Update network and import on other nodes
		network.definition.bootstrapPeers = [bootstrapAddr];
		await writeNetworkFile(network.definition, networkFile);

		for (let i = 1; i < servers.length; i++) {
			await servers[i].call('networks.import', { path: networkFile, enabled: true });
		}

		// Wait for connections
		const allConnected = await waitForCondition(async () => {
			const status = await servers[0].call('getStatus', { networkId: network.definition.networkID });
			return status.connected === NODE_COUNT - 1;
		}, 30000, 1000);
		assert(allConnected, 'All nodes should connect');
		console.log(`  ✓ All ${NODE_COUNT} nodes connected`);

		// Create test data
		console.log(`\n${'='.repeat(60)}`);
		console.log('Creating test data...');
		console.log('='.repeat(60));

		const { dir, files } = await createTestDataDir('/tmp');
		testDataDir = dir;
		console.log(`  Directory: ${dir}`);
		for (const [name, content] of files) {
			console.log(`    - ${name} (${content.length} bytes)`);
		}

		// Import on node 0
		console.log(`\n${'='.repeat(60)}`);
		console.log('Importing data on node 0 (seeder)...');
		console.log('='.repeat(60));

		const importResult = await servers[0].call('import', { path: dir });
		const manifestId = importResult.manifestId;
		console.log(`  Manifest ID: ${manifestId}`);
		assert(manifestId, 'Import should return manifest ID');

		// Get the manifest file path from node 0's data directory
		const manifestPath = join(servers[0].dataDir, 'lish', `${manifestId}.lish`);
		console.log(`  Manifest path: ${manifestPath}`);

		// Verify manifest exists
		const manifestExists = await Bun.file(manifestPath).exists();
		assert(manifestExists, `Manifest file should exist at ${manifestPath}`);

		// Read manifest for node 1
		const manifestContent = await Bun.file(manifestPath).text();
		const tempManifestPath = `/tmp/test-manifest-${Date.now()}.lish`;
		await Bun.write(tempManifestPath, manifestContent);
		console.log(`  Copied manifest to: ${tempManifestPath}`);

		// Download on node 1
		console.log(`\n${'='.repeat(60)}`);
		console.log('Downloading data on node 1 (leecher)...');
		console.log('='.repeat(60));

		// Subscribe to download events
		let downloadComplete = false;
		let downloadError: string | null = null;
		let downloadDir: string | null = null;

		servers[1].on('download:complete', (data: any) => {
			downloadComplete = true;
			downloadDir = data.downloadDir;
			console.log(`  Download complete: ${downloadDir}`);
		});

		servers[1].on('download:error', (data: any) => {
			downloadError = data.error;
			console.log(`  Download error: ${downloadError}`);
		});

		await servers[1].call('subscribe', { events: ['download:complete', 'download:error'] });

		// Start download
		const downloadResult = await servers[1].call('download', {
			networkId: network.definition.networkID,
			manifestPath: tempManifestPath,
		});
		console.log(`  Download started, dir: ${downloadResult.downloadDir}`);

		// Wait for download to complete
		const completed = await waitForCondition(async () => {
			return downloadComplete || downloadError !== null;
		}, 60000, 500);

		assert(completed, 'Download should complete within timeout');
		assert(!downloadError, `Download should not error: ${downloadError}`);
		assert(downloadDir, 'Download directory should be set');

		// Verify downloaded files match original
		console.log(`\n${'='.repeat(60)}`);
		console.log('Verifying downloaded files...');
		console.log('='.repeat(60));

		for (const [name, originalContent] of files) {
			const downloadedPath = join(downloadDir!, name);
			const downloadedFile = Bun.file(downloadedPath);

			assert(await downloadedFile.exists(), `Downloaded file should exist: ${name}`);

			const downloadedContent = new Uint8Array(await downloadedFile.arrayBuffer());
			assert(
				downloadedContent.length === originalContent.length,
				`File size mismatch for ${name}: expected ${originalContent.length}, got ${downloadedContent.length}`
			);

			// Compare bytes
			let match = true;
			for (let i = 0; i < originalContent.length; i++) {
				if (downloadedContent[i] !== originalContent[i]) {
					match = false;
					break;
				}
			}
			assert(match, `File content mismatch for ${name}`);
			console.log(`  ✓ ${name} (${originalContent.length} bytes)`);
		}

		// Cleanup temp manifest
		await Bun.$`rm -f ${tempManifestPath}`.quiet();

		console.log(`\n${'='.repeat(60)}`);
		console.log('✓ All tests passed!');
		console.log(`${'='.repeat(60)}\n`);

	} catch (error) {
		console.error('\n❌ Test failed:', error);
		process.exit(1);
	} finally {
		console.log('Cleaning up...');
		await harness.cleanupAll();
		await Bun.$`rm -f ${networkFile}`.quiet();
		if (testDataDir) {
			await Bun.$`rm -rf ${testDataDir}`.quiet();
		}
	}
}

main();
