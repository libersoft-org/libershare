import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
	root: fileURLToPath(new URL('../../', import.meta.url)),
	publicDir: 'static',
	plugins: [svelte()],
	resolve: { alias: { '@shared': fileURLToPath(new URL('../../../shared/src/index.ts', import.meta.url)) } },
	server: { host: '127.0.0.1', port: 6003, strictPort: true },
});
