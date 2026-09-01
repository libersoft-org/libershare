import { validateIPv4Config, type NetIPv4Config } from '@shared';

export interface NetworkHelperRequest {
	version: 1;
	operation: 'applyIPv4';
	interfaceID: string;
	config: NetIPv4Config;
}

export type NetworkHelperFailure = { ok: false; error: string };
export type NetworkHelperResponse = { ok: true } | NetworkHelperFailure;
type ApplyIPv4 = (interfaceID: string, config: NetIPv4Config) => Promise<unknown>;

const REQUEST_KEYS = ['config', 'interfaceID', 'operation', 'version'];
const CONFIG_KEYS = ['address', 'dns', 'gateway', 'mode', 'prefixLength'];

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
	return Object.keys(value).every(key => allowed.includes(key));
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
		await applyIPv4(request.interfaceID, request.config);
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
