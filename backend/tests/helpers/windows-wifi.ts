import { ptr, type Pointer } from 'bun:ffi';

/** WLAN_AVAILABLE_NETWORK, x64. */
const NETWORK_SIZE = 628;
const LIST_HEADER = 8;

export interface NetworkFields {
	ssid: string;
	signal: number;
	secured?: boolean;
	active?: boolean;
	auth?: number;
	/** Windows' own name for the stored profile. Not the SSID, and often not equal to it. */
	profileName?: string;
	/** Raw SSID octets, for a name that is not valid UTF-8 and so has no text form. */
	ssidOctets?: number[];
	/** bNetworkConnectable. Real lists set this TRUE for anything joinable. */
	connectable?: boolean;
	/** wlanNotConnectableReason, meaningful only when connectable is false. */
	notConnectableReason?: number;
	/** dot11DefaultCipherAlgorithm. Defaults to CCMP for a secured row and NONE for an open one. */
	cipher?: number;
	/** Overrides the SSID's own byte length — used to forge an impossible one. */
	ssidLength?: number;
}

/** Buffers must outlive the pointers handed to the decoder, so every one is retained. */
const retained: Uint8Array[] = [];

/** Build a WLAN_AVAILABLE_NETWORK_LIST holding the given networks. */
export function buildList(networks: NetworkFields[], declaredCount: number = networks.length): Pointer {
	const bytes = new Uint8Array(LIST_HEADER + networks.length * NETWORK_SIZE);
	const view = new DataView(bytes.buffer);
	view.setUint32(0, declaredCount, true);
	view.setUint32(4, 0, true);
	networks.forEach((network, index) => {
		const base = LIST_HEADER + index * NETWORK_SIZE;
		const name = network.ssidOctets ? Uint8Array.from(network.ssidOctets) : new TextEncoder().encode(network.ssid);
		const profile = network.profileName ?? network.ssid;
		for (let i = 0; i < profile.length && i < 256; i++) view.setUint16(base + i * 2, profile.charCodeAt(i), true);
		view.setUint32(base + 512, network.ssidLength ?? name.length, true);
		bytes.set(name.subarray(0, 32), base + 516);
		view.setUint32(base + 556, network.connectable === false ? 0 : 1, true);
		view.setUint32(base + 560, network.notConnectableReason ?? 0, true);
		view.setUint32(base + 604, network.signal, true);
		view.setUint32(base + 608, network.secured === false ? 0 : 1, true);
		view.setUint32(base + 612, network.auth ?? 7, true);
		view.setUint32(base + 616, network.cipher ?? (network.secured === false ? 0 : 4), true);
		view.setUint32(base + 620, network.active ? 1 : 0, true);
	});
	retained.push(bytes);
	return ptr(bytes);
}

