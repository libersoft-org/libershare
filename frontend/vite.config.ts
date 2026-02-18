import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, type Plugin } from 'vite';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getCommitHash(): string {
	try {
		return execSync('git rev-parse --short HEAD').toString().trim();
	} catch {
		return 'unknown';
	}
}

function getBuildDate(): string {
	const now = new Date();
	return now.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

// Serve country flag SVGs from node_modules in dev, build scripts handle production copy
function countryFlags(): Plugin {
	const flagsDir = path.resolve(__dirname, 'node_modules/country-flags/svg');
	return {
		name: 'country-flags',
		configureServer(server) {
			server.middlewares.use('/flags', (req, res, next) => {
				const file = path.join(flagsDir, req.url || '');
				if (fs.existsSync(file)) {
					res.setHeader('Content-Type', 'image/svg+xml');
					fs.createReadStream(file).pipe(res);
				} else next();
			});
		},
	};
}

export default defineConfig({
	plugins: [sveltekit(), countryFlags()],
	define: {
		__BUILD_DATE__: JSON.stringify(getBuildDate()),
		__COMMIT_HASH__: JSON.stringify(getCommitHash()),
	},
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
