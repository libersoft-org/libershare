import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		adapter: adapter({
			pages: 'build',
			assets: 'build',
			fallback: undefined,
			precompress: false,
			strict: true,
		}),
		prerender: {
			handleHttpError: 'warn',
		},
		alias: {
			'@libershare/shared': path.resolve(__dirname, '../shared/src/index.ts'),
			'@libershare/shared/*': path.resolve(__dirname, '../shared/src/*'),
		},
	},
};

export default config;
