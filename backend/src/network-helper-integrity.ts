import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';

declare const LISH_NETWORK_HELPER_SHA256: string | undefined;

export function expectedNetworkHelperHash(): string | null {
	const value = typeof LISH_NETWORK_HELPER_SHA256 === 'string' ? LISH_NETWORK_HELPER_SHA256.toLowerCase() : '';
	return /^[0-9a-f]{64}$/.test(value) ? value : null;
}

export async function sha256File(path: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = createHash('sha256');
		const stream = createReadStream(path);
		stream.on('error', reject);
		stream.on('data', chunk => hash.update(chunk));
		stream.on('end', () => resolve(hash.digest('hex')));
	});
}
