import { plugin } from 'bun';
import { compileModule } from 'svelte/compiler';
import { readFileSync } from 'fs';

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
