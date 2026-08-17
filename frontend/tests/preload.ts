import { plugin } from 'bun';
import { mock } from 'bun:test';
import { compileModule } from 'svelte/compiler';
import { readFileSync } from 'fs';
import { fakeAPI } from './api-mock.ts';

/**
 * Replace the WebSocket transport once, for the whole suite.
 *
 * Here rather than in the test files that need it, because `mock.module()` is a
 * global registry with no per-file scope and no undo — see `api-mock.ts`. Importing
 * the real `api.ts` would open a socket from a unit test regardless.
 */
mock.module('../src/scripts/api.ts', () => ({ api: fakeAPI }));

/**
 * Teach `bun test` to load `.svelte.ts` modules.
 *
 * Runes are compiler syntax, not runtime calls, so a `.svelte.ts` file is not
 * valid JavaScript until Svelte has been over it — bun would otherwise fail on
 * `$state` as an undefined identifier. Vite does this for the app through
 * `@sveltejs/vite-plugin-svelte`; tests get the same treatment here, using the
 * same Svelte version the app builds with.
 *
 * TypeScript is stripped first because `compileModule` parses JavaScript. Both
 * steps are the ones the Vite plugin performs, in the same order.
 *
 * `*.svelte.test.ts` is compiled too, so a test can open an `$effect.root` and
 * drive a rune module the way a component instance would.
 */
const typescript = new Bun.Transpiler({ loader: 'ts' });

plugin({
	name: 'svelte-module',
	setup(build) {
		build.onLoad({ filter: /\.svelte(\.test)?\.ts$/ }, args => {
			const source = readFileSync(args.path, 'utf8');
			const compiled = compileModule(typescript.transformSync(source), { filename: args.path, generate: 'client' });
			return { contents: compiled.js.code, loader: 'js' };
		});
	},
});
