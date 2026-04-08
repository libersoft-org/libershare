import { canonicalize } from 'json-canonicalize';
import { createHash } from 'crypto';

export function computeManifestHash(manifest: Record<string, unknown>): string {
	const canonical = canonicalize(manifest);
	const hash = createHash('sha256').update(canonical).digest('hex');
	return `sha256:${hash}`;
}
