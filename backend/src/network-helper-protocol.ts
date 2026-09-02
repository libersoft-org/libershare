import { MAX_DNS_SERVERS, validateIPv4Config, type NetIPv4Baseline, type NetIPv4Config } from '@shared';

export interface NetworkHelperRequest {
	version: 1;
	operation: 'applyIPv4';
	interfaceID: string;
	config: NetIPv4Config;
	/** The configuration the change was built on; the helper refuses to apply over anything else. */
	expected?: NetIPv4Baseline;
}

/** Exit codes of the helper when it reports through the process status instead of stdout. */
export const NETWORK_HELPER_EXIT = { applied: 0, rejected: 10 } as const;

export type NetworkHelperFailure = { ok: false; error: string };
export type NetworkHelperResponse = { ok: true } | NetworkHelperFailure;
type ApplyIPv4 = (interfaceID: string, config: NetIPv4Config, expected?: NetIPv4Baseline) => Promise<unknown>;

const REQUEST_KEYS = ['config', 'expected', 'interfaceID', 'operation', 'version'];
const CONFIG_KEYS = ['address', 'dns', 'gateway', 'mode', 'prefixLength'];
const BASELINE_KEYS = ['address', 'dns', 'gateway', 'mode', 'prefixLength'];
const MAX_BASELINE_VALUE_LENGTH = 64;

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
	return Object.keys(value).every(key => allowed.includes(key));
}

function isBoundedStringOrNull(value: unknown): boolean {
	return value === null || (typeof value === 'string' && value.length <= MAX_BASELINE_VALUE_LENGTH && !/\p{Cc}/u.test(value));
}

/** Accept only a baseline of the exact shape the backend builds; it is compared, never executed, but it still crosses a privilege boundary. */
function isNetworkHelperBaseline(value: unknown): value is NetIPv4Baseline {
	if (!value || typeof value !== 'object' || Array.isArray(value) || !hasOnlyKeys(value as Record<string, unknown>, BASELINE_KEYS)) return false;
	const baseline = value as Partial<Record<keyof NetIPv4Baseline, unknown>>;
	return (baseline.mode === 'dhcp' || baseline.mode === 'static' || baseline.mode === 'unknown') && isBoundedStringOrNull(baseline.address) && (baseline.prefixLength === null || (Number.isInteger(baseline.prefixLength) && (baseline.prefixLength as number) >= 0 && (baseline.prefixLength as number) <= 32)) && isBoundedStringOrNull(baseline.gateway) && Array.isArray(baseline.dns) && baseline.dns.length <= MAX_DNS_SERVERS && baseline.dns.every(server => typeof server === 'string' && isBoundedStringOrNull(server));
}

export function encodeNetworkHelperRequest(request: NetworkHelperRequest): string {
	return Buffer.from(JSON.stringify(request)).toString('base64url');
}

export function decodeNetworkHelperRequest(encoded: string): NetworkHelperRequest {
	if (!/^[A-Za-z0-9_-]{1,8192}$/.test(encoded)) throw new Error('invalid network helper request encoding');
	let value: unknown;
	try {
		value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
	} catch {
		throw new Error('invalid network helper request');
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid network helper request');
	const request = value as Partial<NetworkHelperRequest>;
	if (!hasOnlyKeys(request as Record<string, unknown>, REQUEST_KEYS)) throw new Error('invalid network helper request');
	if (request.version !== 1 || request.operation !== 'applyIPv4') throw new Error('unsupported network helper operation');
	if (typeof request.interfaceID !== 'string' || request.interfaceID.length === 0 || new TextEncoder().encode(request.interfaceID).byteLength > 256 || /\p{Cc}/u.test(request.interfaceID)) throw new Error('invalid network helper interface');
	if (!request.config || typeof request.config !== 'object' || Array.isArray(request.config) || !hasOnlyKeys(request.config as unknown as Record<string, unknown>, CONFIG_KEYS)) throw new Error('invalid network helper config');
	const invalid = validateIPv4Config(request.config);
	if (invalid) throw new Error(`invalid network helper ${invalid}`);
	if (request.expected !== undefined && !isNetworkHelperBaseline(request.expected)) throw new Error('invalid network helper baseline');
	return request as NetworkHelperRequest;
}

/**
 * Shape any thrown value into the bounded, control-character-free failure the
 * client can parse.
 *
 * Every path out of the helper goes through here, including the request decode
 * that runs before an operation is even known. An escaping exception would
 * otherwise reach the caller as a runtime stack trace on stderr, and on Linux
 * that text is what the UI shows as the reason the change failed.
 */
export function networkHelperFailure(error: unknown): NetworkHelperFailure {
	const message = (error instanceof Error ? error.message : String(error)).replace(/\p{Cc}/gu, ' ').trim();
	return { ok: false, error: (message || 'network change failed').slice(0, 500) };
}

export async function executeNetworkHelperRequest(request: NetworkHelperRequest, applyIPv4: ApplyIPv4): Promise<NetworkHelperResponse> {
	try {
		await applyIPv4(request.interfaceID, request.config, request.expected);
		return { ok: true };
	} catch (error) {
		return networkHelperFailure(error);
	}
}

export function parseNetworkHelperResponse(text: string): NetworkHelperResponse {
	if (new TextEncoder().encode(text).byteLength > 4096) throw new Error('network helper returned an oversized response');
	let value: unknown;
	try {
		value = JSON.parse(text.trim());
	} catch {
		throw new Error('network helper returned an invalid response');
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('network helper returned an invalid response');
	const response = value as Partial<NetworkHelperResponse>;
	const keys = Object.keys(response);
	if (response.ok === false && keys.length === 2 && keys.includes('error') && typeof response.error === 'string' && response.error.length > 0 && response.error.length <= 500 && !/\p{Cc}/u.test(response.error)) return response as NetworkHelperResponse;
	if (response.ok === true && keys.length === 1) return { ok: true };
	throw new Error('network helper returned an invalid response');
}
