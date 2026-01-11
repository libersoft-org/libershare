import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	plugins: [sveltekit()],
	server: {
		https: fs.existsSync(path.resolve(__dirname, 'server.key'))
			? {
					key: fs.readFileSync(path.resolve(__dirname, 'server.key')),
					cert: fs.readFileSync(path.resolve(__dirname, 'server.crt')),
				}
			: fs.existsSync(path.resolve(__dirname, 'certs/server.key'))
				? {
						key: fs.readFileSync(path.resolve(__dirname, 'certs/server.key')),
						cert: fs.readFileSync(path.resolve(__dirname, 'certs/server.crt')),
					}
				: undefined,
		allowedHosts: true,
		host: true,
		port: 6003,
	},
});
