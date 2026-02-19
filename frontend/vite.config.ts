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
	return now
		.toISOString()
		.replace('T', ' ')
		.replace(/\.\d{3}Z$/, ' UTC');
}

// Serve country flag SVGs from node_modules in dev, copy to build output in production
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
		closeBundle() {
			// Copy flags to build output during production build
			const outDir = path.resolve(__dirname, 'build', 'flags');
			if (fs.existsSync(flagsDir)) {
				if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
				for (const file of fs.readdirSync(flagsDir)) {
					if (file.endsWith('.svg')) {
						fs.copyFileSync(path.join(flagsDir, file), path.join(outDir, file));
					}
				}
			}
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
		https: (() => {
			const keyPath = process.env.VITE_SSL_KEY;
			const certPath = process.env.VITE_SSL_CERT;
			if (keyPath && certPath && fs.existsSync(keyPath) && fs.existsSync(certPath)) {
				return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
			}
			if (fs.existsSync(path.resolve(__dirname, 'server.key'))) {
				return { key: fs.readFileSync(path.resolve(__dirname, 'server.key')), cert: fs.readFileSync(path.resolve(__dirname, 'server.crt')) };
			}
			if (fs.existsSync(path.resolve(__dirname, 'certs/server.key'))) {
				return { key: fs.readFileSync(path.resolve(__dirname, 'certs/server.key')), cert: fs.readFileSync(path.resolve(__dirname, 'certs/server.crt')) };
			}
			return undefined;
		})(),
		allowedHosts: true,
		host: true,
		port: 6003,
	},
});
