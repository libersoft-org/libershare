/**
 * Dead / unused code dumped here for reference.
 * Can be deleted entirely once confirmed safe.
 */

/**
 * Pretty-print all multiaddrs of the running libp2p node with emoji indicators:
 * 🏠 = loopback, 🏢 = LAN, 🌍 = public, 🔄 = relay
 *
 * Originally in Network class (protocol/network.ts).
 */
export function printMultiaddrs(node: any): void {
	if (!node) {
		console.log('Network not started');
		return;
	}
	const addrs = node.getMultiaddrs();
	console.log('Current multiaddrs:');
	addrs.forEach((addr: any) => {
		let emoji = '?';
		const protos = addr.protos();
		if (protos.some((p: any) => p.name === 'p2p-circuit')) {
			emoji = '🔄';
		} else {
			try {
				const nodeAddr = addr.nodeAddress();
				if (nodeAddr.address === '127.0.0.1' || nodeAddr.address === '::1') emoji = '🏠';
				else if (nodeAddr.family === 4) {
					const octets = nodeAddr.address.split('.').map(Number);
					if (octets[0] === 10 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168)) emoji = '🏢';
					else emoji = '🌍';
				} else if (nodeAddr.family === 6) {
					if (nodeAddr.address.startsWith('fe80:') || nodeAddr.address.startsWith('fc')) emoji = '🏢';
					else emoji = '🌍';
				}
			} catch (e) {}
		}
		console.log(`${emoji} ${addr.toString()}`);
	});
}
