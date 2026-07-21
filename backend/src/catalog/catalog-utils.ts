import { canonicalize } from 'json-canonicalize';
import { createHash } from 'crypto';

/** Canonical (RFC 8785) SHA-256 hash of a LISH manifest, prefixed with the algorithm. */
export function computeManifestHash(manifest: Record<string, unknown>): string {
	const canonical = canonicalize(manifest);
	const hash = createHash('sha256').update(canonical).digest('hex');
	return `sha256:${hash}`;
}
