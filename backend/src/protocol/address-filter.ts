/**
 * Address-based dial filter. Prevents libp2p from dialing multiaddrs whose
 * target IP cannot possibly be reached from this node's local interfaces.
 *
 * Problem: peers advertise every multiaddr they know (via libp2p identify),
 * including private-range LAN addresses that are only reachable from peers
 * on the same L2 segment. A public-IP node receiving those addresses will
 * dutifully try to dial them, consuming 5s per timeout × many addresses per
 * peer × many peers = minutes wasted per re-dial cycle.
 *
 * Strategy: on every dial, look at the first /ip4/ component. If it is:
 *   - not present (DNS, pure p2p-circuit, etc.) → allow (no IP knowledge)
 *   - loopback (127.0.0.0/8) → deny (never useful for a remote peer)
 *   - public (not in RFC1918/LL/CGNAT) → allow (route through default gateway)
 *   - private (RFC1918) → allow only if the IP falls inside one of OUR own
 *     network interface subnets (enumerated live via os.networkInterfaces()).
 *
 * Interfaces are re-enumerated with a short TTL so VPN up/down is picked up
 * without needing a node restart.
 */
import { networkInterfaces } from 'os';

const LOCAL_CIDR_CACHE_TTL_MS = 10_000;

let cachedCidrs: string[] | null = null;
let cachedAt = 0;

/** Convert an IPv4 dotted-quad string to an unsigned 32-bit integer. */
export function ipToUint32(ip: string): number {
	const parts = ip.split('.').map(n => parseInt(n, 10));
	if (parts.length !== 4 || parts.some(p => !Number.isFinite(p) || p < 0 || p > 255)) return 0;
	return ((parts[0]! << 24) >>> 0) + ((parts[1]! << 16) >>> 0) + ((parts[2]! << 8) >>> 0) + parts[3]!;
}

/** Convert a netmask like "255.255.255.0" to its prefix bit count (e.g. 24). */
export function netmaskToCidrBits(mask: string): number {
	const maskN = ipToUint32(mask);
	let bits = 0;
	for (let i = 0; i < 32; i++) {
		if ((maskN & (1 << (31 - i))) !== 0) bits++;
		else break;
	}
	return bits;
}

/** True if `ip` lies inside the CIDR block `net/prefix`. */
export function ipInCIDR(ip: string, cidr: string): boolean {
	const slash = cidr.indexOf('/');
	if (slash < 0) return ip === cidr;
	const net = cidr.slice(0, slash);
	const bits = parseInt(cidr.slice(slash + 1), 10);
	if (!Number.isFinite(bits) || bits < 0 || bits > 32) return false;
	const mask = bits === 0 ? 0 : (-1 << (32 - bits)) >>> 0;
	return (ipToUint32(ip) & mask) === (ipToUint32(net) & mask);
}

/** True for 127.0.0.0/8. */
export function isLoopback(ip: string): boolean {
	const n = ipToUint32(ip);
	return n >= ipToUint32('127.0.0.0') && n <= ipToUint32('127.255.255.255');
}

/**
 * True for RFC1918 / link-local / CGNAT (shared address space). These are
 * only useful when the peer is reachable via the same L2 / VPN tunnel.
 */
export function isPrivate(ip: string): boolean {
	const n = ipToUint32(ip);
	if (n >= ipToUint32('10.0.0.0') && n <= ipToUint32('10.255.255.255')) return true;
	if (n >= ipToUint32('172.16.0.0') && n <= ipToUint32('172.31.255.255')) return true;
	if (n >= ipToUint32('192.168.0.0') && n <= ipToUint32('192.168.255.255')) return true;
	if (n >= ipToUint32('169.254.0.0') && n <= ipToUint32('169.254.255.255')) return true;
	if (n >= ipToUint32('100.64.0.0') && n <= ipToUint32('100.127.255.255')) return true; // CGNAT
	return false;
}

/** Opposite of isPrivate + isLoopback — globally routable space. */
export function isPublic(ip: string): boolean {
	if (isLoopback(ip)) return false;
	if (isPrivate(ip)) return false;
	const n = ipToUint32(ip);
	if (n === 0) return false; // 0.0.0.0 and parse failures
	if (n >= ipToUint32('224.0.0.0')) return false; // multicast + reserved
	return true;
}

/**
 * Walk all non-internal IPv4 interfaces and return each as a `addr/bits` CIDR.
 * Also appends the network-address form so CIDR matching works regardless of
 * whether the caller compares against host or network addresses.
 */
export function enumerateLocalCidrs(): string[] {
	const out = new Set<string>();
	const ifaces = networkInterfaces();
	for (const iface of Object.values(ifaces)) {
		if (!iface) continue;
		for (const addr of iface) {
			if (addr.family !== 'IPv4' || addr.internal) continue;
			const bits = netmaskToCidrBits(addr.netmask);
			out.add(`${addr.address}/${bits}`);
			// Network address form — easier to reason about, same match behaviour.
			const netN = ipToUint32(addr.address) & (bits === 0 ? 0 : ((-1 << (32 - bits)) >>> 0));
			const netIp = [(netN >>> 24) & 0xff, (netN >>> 16) & 0xff, (netN >>> 8) & 0xff, netN & 0xff].join('.');
			out.add(`${netIp}/${bits}`);
		}
	}
	return Array.from(out);
}

/** Cached version of enumerateLocalCidrs() with a 10s TTL so VPN up/down propagates. */
export function getLocalCidrs(now: number = Date.now()): string[] {
	if (!cachedCidrs || now - cachedAt > LOCAL_CIDR_CACHE_TTL_MS) {
		cachedCidrs = enumerateLocalCidrs();
		cachedAt = now;
	}
	return cachedCidrs;
}

/** Force re-enumeration on next call. Used by tests. */
export function resetLocalCidrCache(): void {
	cachedCidrs = null;
	cachedAt = 0;
}

/**
 * Extract the first /ip4/ value from a libp2p multiaddr, if any. Returns
 * null for DNS-only or pure circuit-relay multiaddrs.
 */
export function extractFirstIPv4(ma: any): string | null {
	try {
		const components: Array<{ code: number; value?: string }> = ma?.getComponents?.() ?? [];
		for (const c of components) {
			if (c.code === 4 && typeof c.value === 'string') return c.value;
		}
	} catch {}
	try {
		// Fallback: some multiaddr implementations expose .nodeAddress()
		const na = ma?.nodeAddress?.();
		if (na && (na.family === 4 || na.family === 'IPv4')) return String(na.address);
	} catch {}
	return null;
}

/**
 * Decide whether libp2p should skip dialing this multiaddr. Returns:
 *   - true  → libp2p will NOT attempt the dial (denied)
 *   - false → libp2p proceeds as usual (allowed)
 *
 * Philosophy: fail safe — if we can't parse the IP, let libp2p try (don't
 * over-filter). Only deny when we're sure the dial cannot succeed.
 */
export function shouldDenyDial(ma: any, localCidrs: string[]): boolean {
	const ip = extractFirstIPv4(ma);
	if (!ip) return false; // DNS / circuit-relay / unknown — passthrough
	if (isLoopback(ip)) return true; // remote peers advertising 127.x are useless
	if (isPublic(ip)) return false; // globally routable — always worth trying
	// Private IP: accept only if in one of our own local subnets.
	return !localCidrs.some(cidr => ipInCIDR(ip, cidr));
}
