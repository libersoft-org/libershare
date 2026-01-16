import { TestHarness } from './test-harness.ts';
import { generateKey } from '@libp2p/pnet';
import type { ILISHNetwork } from './makenet.ts';

const NODE_COUNT = 10;

async function createTestNetwork(name: string, bootstrapPeers: string[] = []): Promise<ILISHNetwork> {
	const swarmKey = new Uint8Array(95);
	await generateKey(swarmKey);

	return {
		version: 1,
		networkID: crypto.randomUUID(),
		swarmKey: swarmKey.toBase64(),
		name,
		description: `Test network with ${NODE_COUNT} nodes`,
		bootstrapPeers,
		created: new Date().toISOString(),
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

async function main() {
	const harness = new TestHarness();
	// harness.debug = true;  // Uncomment to see server output

	const networkFile = `/tmp/test-network-${Date.now()}.lishnet`;

	try {
		console.log(`\n${'='.repeat(60)}`);
		console.log(`Creating ${NODE_COUNT} test nodes...`);
		console.log('='.repeat(60));

		// Create all servers in parallel
		const serverPromises = Array.from({ length: NODE_COUNT }, (_, i) =>
			harness.createServer(`node${i}`)
		);
		const servers = await Promise.all(serverPromises);

		console.log('\nNodes created:');
		for (const server of servers) {
			console.log(`  - ${server.apiUrl} (${server.dataDir})`);
		}

		// Create network definition
		console.log(`\n${'='.repeat(60)}`);
		console.log('Creating test network definition...');
		console.log('='.repeat(60));

		const network = await createTestNetwork('TestNet-10');
		await writeNetworkFile(network, networkFile);
		console.log(`  Network ID: ${network.networkID}`);
		console.log(`  Network file: ${networkFile}`);

		// Import network on all nodes
		console.log(`\n${'='.repeat(60)}`);
		console.log('Importing network on all nodes...');
		console.log('='.repeat(60));

		const importPromises = servers.map(async (server, i) => {
			const result = await server.call('networks.import', {
				path: networkFile,
				enabled: false,
			});
			console.log(`  Node ${i}: imported network ${result.id.slice(0, 8)}...`);
			return result;
		});
		await Promise.all(importPromises);

		// Verify all nodes have the network
		console.log(`\n${'='.repeat(60)}`);
		console.log('Verifying network on all nodes...');
		console.log('='.repeat(60));

		for (let i = 0; i < servers.length; i++) {
			const networks = await servers[i].call('networks.list');
			const hasNetwork = networks.some((n: any) => n.id === network.networkID);
			console.log(`  Node ${i}: ${hasNetwork ? '✓' : '✗'} has network (${networks.length} total)`);
			assert(hasNetwork, `Node ${i} missing network`);
		}

		// Enable network on first node to get its peer info
		console.log(`\n${'='.repeat(60)}`);
		console.log('Enabling network on node 0 (bootstrap node)...');
		console.log('='.repeat(60));

		await servers[0].call('networks.setEnabled', {
			networkId: network.networkID,
			enabled: true,
		});

		// Wait for the network to start
		await Bun.sleep(2000);

		// Get node 0's addresses
		const nodeInfo = await servers[0].call('getNodeInfo', {
			networkId: network.networkID,
		});
		console.log(`  Node 0 peer ID: ${nodeInfo.peerId}`);
		console.log(`  Node 0 addresses: ${nodeInfo.addresses.length}`);
		for (const addr of nodeInfo.addresses) {
			console.log(`    - ${addr}`);
		}

		assert(nodeInfo.peerId, 'Node 0 must have peer ID');
		assert(nodeInfo.addresses.length > 0, 'Node 0 must have addresses');

		// Find a usable bootstrap address
		const bootstrapAddr = nodeInfo.addresses.find((a: string) =>
			a.includes('/tcp/') && !a.includes('127.0.0.1') && !a.includes('/p2p-circuit/')
		) || nodeInfo.addresses.find((a: string) =>
			a.includes('/tcp/') && !a.includes('/p2p-circuit/')
		);

		assert(bootstrapAddr, 'Must have a usable bootstrap address');
		console.log(`\n  Bootstrap address: ${bootstrapAddr}`);

		// Update network with bootstrap peer and re-import on other nodes
		console.log(`\n${'='.repeat(60)}`);
		console.log('Updating network with bootstrap peer...');
		console.log('='.repeat(60));

		network.bootstrapPeers = [bootstrapAddr];
		await writeNetworkFile(network, networkFile);

		// Re-import on nodes 1-9
		for (let i = 1; i < servers.length; i++) {
			await servers[i].call('networks.import', {
				path: networkFile,
				enabled: false,
			});
			console.log(`  Node ${i}: re-imported with bootstrap peer`);
		}

		// Enable network on remaining nodes
		console.log(`\n${'='.repeat(60)}`);
		console.log('Enabling network on nodes 1-9...');
		console.log('='.repeat(60));

		const enablePromises = servers.slice(1).map(async (server, i) => {
			await server.call('networks.setEnabled', {
				networkId: network.networkID,
				enabled: true,
			});
			console.log(`  Node ${i + 1}: network enabled`);
		});
		await Promise.all(enablePromises);

		// Wait for all connections to establish (poll with timeout)
		console.log(`\n${'='.repeat(60)}`);
		console.log('Waiting for peer connections...');
		console.log('='.repeat(60));

		const expectedBootstrapConnections = NODE_COUNT - 1;

		const allConnected = await waitForCondition(async () => {
			const status = await servers[0].call('getStatus', { networkId: network.networkID });
			process.stdout.write(`\r  Bootstrap node: ${status.connected}/${expectedBootstrapConnections} connections`);
			return status.connected === expectedBootstrapConnections;
		}, 30000, 1000);

		console.log('');
		assert(allConnected, `Bootstrap node did not receive all ${expectedBootstrapConnections} connections within timeout`);

		// Verify final state - collect peer IDs and verify connections
		console.log(`\n${'='.repeat(60)}`);
		console.log('Verifying peer connections...');
		console.log('='.repeat(60));

		// Get all node peer IDs
		const nodePeerIds: string[] = [];
		for (let i = 0; i < servers.length; i++) {
			const info = await servers[i].call('getNodeInfo', { networkId: network.networkID });
			nodePeerIds.push(info.peerId);
		}

		// Verify each node's connections
		for (let i = 0; i < servers.length; i++) {
			const status = await servers[i].call('getStatus', {
				networkId: network.networkID,
			});
			console.log(`  Node ${i}: ${status.connected} peers, ${status.peersInStore} in store`);

			if (i === 0) {
				// Bootstrap node should be connected to all other nodes
				assert(
					status.connected === expectedBootstrapConnections,
					`Bootstrap node should have ${expectedBootstrapConnections} connections, has ${status.connected}`
				);
				// Verify it's connected to the expected peer IDs
				const expectedPeers = nodePeerIds.slice(1);
				for (const expectedPeer of expectedPeers) {
					assert(
						status.connectedPeers.includes(expectedPeer),
						`Bootstrap node should be connected to ${expectedPeer.slice(0, 12)}...`
					);
				}
				console.log(`    ✓ Connected to all ${expectedBootstrapConnections} expected peer IDs`);
			} else {
				// Other nodes should be connected to bootstrap
				assert(
					status.connected >= 1,
					`Node ${i} should have at least 1 connection, has ${status.connected}`
				);
				assert(
					status.connectedPeers.includes(nodePeerIds[0]),
					`Node ${i} should be connected to bootstrap node ${nodePeerIds[0].slice(0, 12)}...`
				);
				console.log(`    ✓ Connected to bootstrap node`);
			}
		}

		// Test disabling network
		console.log(`\n${'='.repeat(60)}`);
		console.log('Testing network disable on node 5...');
		console.log('='.repeat(60));

		await servers[5].call('networks.setEnabled', {
			networkId: network.networkID,
			enabled: false,
		});

		const node5Networks = await servers[5].call('networks.list');
		const node5Net = node5Networks.find((n: any) => n.id === network.networkID);
		assert(node5Net?.enabled === false, 'Node 5 network should be disabled');
		console.log(`  Node 5 network disabled: ✓`);

		// getStatus should fail since network is stopped
		let statusFailed = false;
		try {
			await servers[5].call('getStatus', { networkId: network.networkID });
		} catch {
			statusFailed = true;
		}
		assert(statusFailed, 'getStatus should fail when network is stopped');
		console.log(`  Node 5 getStatus correctly fails: ✓`);

		// Re-enable
		await servers[5].call('networks.setEnabled', {
			networkId: network.networkID,
			enabled: true,
		});

		const node5NetworksAfter = await servers[5].call('networks.list');
		const node5NetAfter = node5NetworksAfter.find((n: any) => n.id === network.networkID);
		assert(node5NetAfter?.enabled === true, 'Node 5 network should be re-enabled');
		console.log(`  Node 5 re-enabled: ✓`);

		// Verify node 5 reconnects to bootstrap
		const reconnected = await waitForCondition(async () => {
			const status = await servers[5].call('getStatus', { networkId: network.networkID });
			return status.connected >= 1;
		}, 10000, 500);
		assert(reconnected, 'Node 5 should reconnect after re-enable');
		console.log(`  Node 5 reconnected: ✓`);

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
	}
}

main();
