import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Compiled workers share their app/helper executable; source workers use a real CLI entry. */
export function selfProcessCommand(flag: '--access-probe' | '--clock-probe', argument: string): string[] {
	const modulePath = import.meta.path.replaceAll('\\', '/');
	if (modulePath.includes('/$bunfs/') || modulePath.includes('/~BUN/')) return [process.execPath, flag, argument];
	const app = fileURLToPath(new URL('../app.ts', import.meta.url));
	const helper = fileURLToPath(new URL('../network-helper.ts', import.meta.url));
	const entry = process.argv[1] && resolve(process.argv[1]) === resolve(helper) ? helper : app;
	if (!existsSync(entry)) throw new Error('The internal probe entry point is unavailable');
	return [process.execPath, entry, flag, argument];
}
