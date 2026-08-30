import type { NetAddressMode, NetCapabilities, NetInterfaceInfo, NetIPv4Config, NetworkStateInfo } from '@shared';

export type DnsUpdateMode = 'unchanged' | 'automatic' | 'custom';

export interface NetworkConfigForm {
	mode: NetAddressMode;
	address: string;
	prefix: string;
	gateway: string;
	dnsMode: DnsUpdateMode;
	dns: string;
}

/** The detail screen may offer IPv4, Wi-Fi, or both independently. */
export function canOpenNetworkConfig(source: NetInterfaceInfo, capabilities: NetCapabilities, detail: NetworkStateInfo['detail']): boolean {
	if (detail !== 'full') return false;
	return (capabilities.ipv4 && source.ipv4Configurable) || (capabilities.wifi && source.medium === 'wireless');
}

/** Seed the editable fields without discarding any resolver family. */
export function networkConfigFormFrom(source: NetInterfaceInfo): NetworkConfigForm {
	const ipv4 = source.addresses.find(address => address.family === 'ipv4');
	return {
		mode: source.ipv4Mode,
		address: ipv4?.address ?? '',
		prefix: String(ipv4?.prefixLength ?? 24),
		gateway: source.gateway ?? '',
		dnsMode: 'unchanged',
		dns: source.dns.join(', '),
	};
}

/** Build the RPC value. Omitted DNS is the explicit preserve-current contract. */
export function networkConfigFromForm(form: NetworkConfigForm): NetIPv4Config | null {
	if (form.mode === 'unknown') return null;
	const config: NetIPv4Config =
		form.mode === 'dhcp'
			? { mode: 'dhcp' }
			: {
					mode: 'static',
					address: form.address.trim(),
					prefixLength: Number(form.prefix.trim()),
					gateway: form.gateway.trim(),
				};
	if (form.dnsMode === 'automatic') config.dns = [];
	if (form.dnsMode === 'custom') {
		config.dns = form.dns
			.split(',')
			.map(server => server.trim())
			.filter(Boolean);
	}
	return config;
}
