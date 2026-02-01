import { TestHarness } from './test-harness.ts';
import { generateKey } from '@libp2p/pnet';
import { type ILISHNetwork } from '../../src/makenet.ts';

const NODE_COUNT = 10;

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
			description: `Test network with ${NODE_COUNT} nodes`,
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
		await writeNetworkFile(network.definition, networkFile);
		console.log(`  Network ID: ${network.definition.networkID}`);
		console.log(`  Network file: ${networkFile}`);

		// Import network on all nodes
		console.log(`\n${'='.repeat(60)}`);
		console.log('Importing network on all nodes...');
		console.log('='.repeat(60));

		const importPromises = servers.map(async (server, i) => {
			const result = await server.call('networks.importFromFile', {
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
			const hasNetwork = networks.some((n: any) => n.id === network.definition.networkID);
			console.log(`  Node ${i}: ${hasNetwork ? '✓' : '✗'} has network (${networks.length} total)`);
			assert(hasNetwork, `Node ${i} missing network`);
		}

		// Enable network on first node to get its peer info
		console.log(`\n${'='.repeat(60)}`);
		console.log('Enabling network on node 0 (bootstrap node)...');
		console.log('='.repeat(60));

		await servers[0].call('networks.setEnabled', {
			networkId: network.definition.networkID,
			enabled: true,
		});

		// Wait for the network to start
		await Bun.sleep(2000);

		// Get node 0's addresses
		const nodeInfo = await servers[0].call('networks.getNodeInfo', {
			networkId: network.definition.networkID,
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

		network.definition.bootstrapPeers = [bootstrapAddr];
		await writeNetworkFile(network.definition, networkFile);

		// Re-import on nodes 1-9
		for (let i = 1; i < servers.length; i++) {
			await servers[i].call('networks.importFromFile', {
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
				networkId: network.definition.networkID,
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
			const status = await servers[0].call('networks.getStatus', { networkId: network.definition.networkID });
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
			const info = await servers[i].call('networks.getNodeInfo', { networkId: network.definition.networkID });
			nodePeerIds.push(info.peerId);
		}

		// Verify each node's connections
		for (let i = 0; i < servers.length; i++) {
			const status = await servers[i].call('networks.getStatus', {
				networkId: network.definition.networkID,
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
			networkId: network.definition.networkID,
			enabled: false,
		});

		const node5Networks = await servers[5].call('networks.list');
		const node5Net = node5Networks.find((n: any) => n.id === network.definition.networkID);
		assert(node5Net?.enabled === false, 'Node 5 network should be disabled');
		console.log(`  Node 5 network disabled: ✓`);

		// networks.getStatus should fail since network is stopped
		let statusFailed = false;
		try {
			await servers[5].call('networks.getStatus', { networkId: network.definition.networkID });
		} catch {
			statusFailed = true;
		}
		assert(statusFailed, 'networks.getStatus should fail when network is stopped');
		console.log(`  Node 5 networks.getStatus correctly fails: ✓`);

		// Re-enable
		await servers[5].call('networks.setEnabled', {
			networkId: network.definition.networkID,
			enabled: true,
		});

		const node5NetworksAfter = await servers[5].call('networks.list');
		const node5NetAfter = node5NetworksAfter.find((n: any) => n.id === network.definition.networkID);
		assert(node5NetAfter?.enabled === true, 'Node 5 network should be re-enabled');
		console.log(`  Node 5 re-enabled: ✓`);

		// Verify node 5 reconnects to bootstrap
		const reconnected = await waitForCondition(async () => {
			const status = await servers[5].call('networks.getStatus', { networkId: network.definition.networkID });
			return status.connected >= 1;
		}, 10000, 500);
		assert(reconnected, 'Node 5 should reconnect after re-enable');
		console.log(`  Node 5 reconnected: ✓`);

		// Test network isolation with different PSK
		console.log(`\n${'='.repeat(60)}`);
		console.log('Testing network isolation (different PSK)...');
		console.log('='.repeat(60));

		// Create a second network with different swarm key
		const network2File = `/tmp/test-network2-${Date.now()}.lishnet`;
		const network2 = await createTestNetwork('TestNet-Isolated');
		await writeNetworkFile(network2.definition, network2File);
		console.log(`  Created network 2: ${network2.definition.networkID.slice(0, 8)}...`);

		// Import and enable network 2 on node 9 only
		await servers[9].call('networks.importFromFile', {
			path: network2File,
			enabled: true,
		});
		console.log(`  Node 9: imported and enabled network 2`);

		// Wait for network 2 to be running on node 9
		const net2Running = await waitForCondition(async () => {
			try {
				await servers[9].call('networks.getNodeInfo', { networkId: network2.definition.networkID });
				return true;
			} catch {
				return false;
			}
		}, 10000, 500);
		assert(net2Running, 'Network 2 should start on node 9');

		// Get node 9's address on network 2
		const node9Net2Info = await servers[9].call('networks.getNodeInfo', {
			networkId: network2.definition.networkID,
		});
		const node9Net2Addr = node9Net2Info.addresses.find((a: string) =>
			a.includes('/tcp/') && !a.includes('/p2p-circuit/')
		);
		assert(node9Net2Addr, 'Node 9 must have an address on network 2');
		console.log(`  Node 9 network 2 address: ${node9Net2Addr}`);

		// Get node 1's address on network 1 for comparison
		const node1Net1Info = await servers[1].call('networks.getNodeInfo', {
			networkId: network.definition.networkID,
		});
		const node1Net1Addr = node1Net1Info.addresses.find((a: string) =>
			a.includes('/tcp/') && !a.includes('/p2p-circuit/')
		);
		assert(node1Net1Addr, 'Node 1 must have an address on network 1');
		console.log(`  Node 1 network 1 address: ${node1Net1Addr}`);

		// Test 1: Node 0 CAN connect to Node 1 on network 1 (same PSK)
		console.log(`\n  Testing same-network connection...`);
		try {
			await servers[0].call('networks.connect', {
				networkId: network.definition.networkID,
				multiaddr: node1Net1Addr,
			});
			console.log(`    ✓ Node 0 -> Node 1 (same network): connected`);
		} catch (err: any) {
			throw new Error(`Same-network connection should succeed: ${err.message}`);
		}

		// Test 2: Node 0 CANNOT connect to Node 9's network 2 address (different PSK)
		console.log(`  Testing cross-network connection (should fail)...`);
		let crossNetworkFailed = false;
		try {
			await servers[0].call('networks.connect', {
				networkId: network.definition.networkID,
				multiaddr: node9Net2Addr,
			});
			// If we get here, connection didn't fail - wait a bit and check if it actually connected
			await Bun.sleep(2000);
			const status = await servers[0].call('networks.getStatus', { networkId: network.definition.networkID });
			// Node 9's network 2 peer ID should NOT be in our connected peers
			if (!status.connectedPeers.includes(node9Net2Info.peerId)) {
				crossNetworkFailed = true;
			}
		} catch {
			crossNetworkFailed = true;
		}
		assert(crossNetworkFailed, 'Cross-network connection (different PSK) should fail');
		console.log(`    ✓ Node 0 -> Node 9 (different network): correctly rejected`);

		// Cleanup network 2 file
		await Bun.$`rm -f ${network2File}`.quiet();

		// Test mangled PSK - same network ID but corrupted key
		console.log(`\n${'='.repeat(60)}`);
		console.log('Testing mangled PSK rejection...');
		console.log('='.repeat(60));

		// Create a network with same ID as network 1 but mangled key
		const mangledKeyBytes = new Uint8Array(network.swarmKeyBytes);
		mangledKeyBytes[50] ^= 0x01;  // Flip one bit
		const mangledNetworkDef: ILISHNetwork = {
			...network.definition,
			swarmKey: mangledKeyBytes.toBase64(),
		};

		const mangledNetworkFile = `/tmp/test-network-mangled-${Date.now()}.lishnet`;
		await writeNetworkFile(mangledNetworkDef, mangledNetworkFile);
		console.log(`  Created mangled network (same ID, corrupted PSK)`);

		// Delete the original network definition
		await servers[8].call('networks.delete', { networkId: network.definition.networkID });
		// Import the mangled version
		await servers[8].call('networks.importFromFile', {
			path: mangledNetworkFile,
			enabled: true,
		});
		console.log(`  Node 8: imported mangled network definition`);

		// Wait for mangled network to start
		const mangledRunning = await waitForCondition(async () => {
			try {
				await servers[8].call('networks.getNodeInfo', { networkId: network.definition.networkID });
				return true;
			} catch {
				return false;
			}
		}, 10000, 500);
		assert(mangledRunning, 'Mangled network should start on node 8');

		// Get node 8's address on the mangled network
		const node8MangledInfo = await servers[8].call('networks.getNodeInfo', {
			networkId: network.definition.networkID,
		});
		console.log(`  Node 8 mangled network peer ID: ${node8MangledInfo.peerId.slice(0, 12)}...`);

		// Try to connect node 8 (mangled PSK) to node 0 (correct PSK)
		// They have the same network ID but different keys - should fail
		console.log(`  Testing mangled PSK connection to bootstrap...`);
		let mangledConnectionFailed = false;
		try {
			await servers[8].call('networks.connect', {
				networkId: network.definition.networkID,
				multiaddr: bootstrapAddr,
			});
			// Wait and check if connection actually established
			await Bun.sleep(3000);
			const status = await servers[8].call('networks.getStatus', { networkId: network.definition.networkID });
			// Should NOT be connected to node 0
			if (!status.connectedPeers.includes(nodePeerIds[0])) {
				mangledConnectionFailed = true;
			}
		} catch {
			mangledConnectionFailed = true;
		}
		assert(mangledConnectionFailed, 'Node with mangled PSK should not connect to correct network');
		console.log(`    ✓ Node 8 (mangled PSK) -> Node 0 (correct PSK): correctly rejected`);

		// Cleanup mangled network file
		await Bun.$`rm -f ${mangledNetworkFile}`.quiet();

		console.log(`\n${'='.repeat(60)}`);
		console.log('✓ All tests passed!');
		console.log(`${'='.repeat(60)}\n`);

	} catch (error) {
		console.error('\n❌ Test failed:', error);
		throw error;
	} finally {
		console.log('Cleaning up...');
		await harness.cleanupAll();
		await Bun.$`rm -f ${networkFile}`.quiet();
	}
}

main();
