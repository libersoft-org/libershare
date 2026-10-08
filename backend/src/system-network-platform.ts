import type { NetCapabilities, NetInterfaceInfo, NetIPv4Config, NetWifiNetwork, NetworkStateInfo } from '@shared';

/** What one platform reader returns before the shared layer adds primary selection and capabilities. */
export interface NetworkPlatformRead {
	interfaces: NetInterfaceInfo[];
	/** The platform manages at least one device, but reading its saved profiles failed or was incomplete. */
	ipv4ProfilesUnavailable: boolean;
}

/** IPv4 change details the shared layer has already worked out from the fresh host state. */
export interface NetworkPlatformIPv4Options {
	readonly addressingChanged: boolean;
	readonly requireLease: boolean;
}

/**
 * Everything one operating system contributes to reading and changing the network.
 *
 * `system-network.ts` keeps the shared rules (validation, baselines, locking, cache, read-back)
 * and reaches the host only through this interface, so a new platform is one implementation
 * plus one entry in its registry. Interface ids are passed as received: each implementation
 * validates the id form it owns (a Windows adapter GUID is not a device name).
 */
export interface NetworkPlatform {
	/** `full` when the reader describes addressing modes, gateways and DNS; `addressesOnly` otherwise. */
	readonly detail: NetworkStateInfo['detail'];
	read(): Promise<NetworkPlatformRead>;
	capabilities(): Promise<NetCapabilities>;
	/** Refuse while a platform-owned change of this kind is still running outside the shared lock. */
	assertIdle(kind: 'ipv4' | 'wifi'): void;
	applyIPv4(interfaceID: string, config: NetIPv4Config, options: NetworkPlatformIPv4Options): Promise<void>;
	scanWifi(interfaceID: string): Promise<NetWifiNetwork[]>;
	/** Join `network`, a fresh scan result the shared layer has matched to the request. */
	joinWifi(interfaceID: string, password: string, network: NetWifiNetwork): Promise<void>;
	disconnectWifi(interfaceID: string): Promise<void>;
}
