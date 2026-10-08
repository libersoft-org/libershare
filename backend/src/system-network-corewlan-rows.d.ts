import type { NetWifiNetwork } from '@shared';
import type { MacWifiInterface } from './system-network-corewlan.ts';

/** What CoreWLAN reports about one interface, before any presentation. */
export interface CoreWlanSnapshot {
	device: string | null;
	interfaceMode: number;
	ssidHex: string | null;
	bssid: string | null;
	securityType: number;
	signal: number;
	powerOn: boolean;
}

/** One scanned access point, before any presentation. */
export interface CoreWlanNetwork {
	ssidHex: string | null;
	bssid: string | null;
	securityType: number;
	signal: number;
}

export function coreWlanNamesVisible(current: CoreWlanSnapshot, networks?: CoreWlanNetwork[], previous?: boolean): boolean;
export function coreWlanInterfaceState(snapshot: CoreWlanSnapshot, namesVisible: boolean): MacWifiInterface;
export function coreWlanScanRows(networks: CoreWlanNetwork[], current: CoreWlanSnapshot): NetWifiNetwork[];
