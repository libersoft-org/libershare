import { Network } from './network.ts';

// Příklad 1: Spusť tento soubor na prvním stroji
async function runPeer1() {
	const network = new Network();
	await network.start();
	console.log('\n=== Peer 1 je připraven ===');
	console.log('Zkopíruj jednu z adres výše a použij ji v Peer 2');
	// Udrž běžící
	await new Promise(() => {});
}

// Příklad 2: Spusť tento soubor na druhém stroji s adresou z Peer 1
async function runPeer2(connectTo?: string) {
	const network = new Network();
	await network.start();
	if (connectTo) {
		console.log('\n=== Připojuji se k Peer 1 ===');
		await network.connectToPeer(connectTo);
		// Počkej chvíli na připojení
		await new Promise(resolve => setTimeout(resolve, 2000));
		const peers = network.getConnectedPeers();
		console.log('Připojeni peeři:', peers.length);
		peers.forEach(p => console.log('  -', p));
	}
	// Udrž běžící
	await new Promise(() => {});
}

// Main
const args = process.argv.slice(2);
if (args.length === 0) {
	console.log('Použití:');
	console.log('  Peer 1: bun network-example.ts');
	console.log('  Peer 2: bun network-example.ts <multiaddr-z-peer1>');
	console.log('');
	console.log('Příklad:');
	console.log('  bun network-example.ts "/ip4/192.168.1.100/tcp/46163/p2p/12D3KooW..."');
	process.exit(1);
}
const peerAddress = args[0];
if (peerAddress.startsWith('/ip4')) runPeer2(peerAddress);
else runPeer1();
