import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, type Plugin } from 'vite';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getBackendProxyTarget(): string {
	return process.env['VITE_BACKEND_URL'] || 'ws://localhost:1158';
}

/**
 * The backend's HTTP origin for `/status`. Vite appends the request path to the target's path,
 * so the target is the bare origin — a path here would turn `/status` into `/status/status`.
 */
function getBackendStatusTarget(): string {
	const target = new URL(getBackendProxyTarget());
	target.protocol = target.protocol === 'wss:' ? 'https:' : 'http:';
	target.pathname = '/';
	target.search = '';
	target.hash = '';
	return target.toString();
}

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
		configureServer(server): void {
			server.middlewares.use('/flags', (req, res, next) => {
				const file = path.join(flagsDir, req.url || '');
				if (fs.existsSync(file)) {
					res.setHeader('Content-Type', 'image/svg+xml');
					fs.createReadStream(file).pipe(res);
				} else next();
			});
		},
		closeBundle(): void {
			// Copy flags to build output during production build
			const outDir = path.resolve(__dirname, 'build', 'flags');
			if (fs.existsSync(flagsDir)) {
				if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
				for (const file of fs.readdirSync(flagsDir)) if (file.endsWith('.svg')) fs.copyFileSync(path.join(flagsDir, file), path.join(outDir, file));
			}
		},
	};
}

export default defineConfig({
	cacheDir: path.resolve(process.cwd(), '.vite-cache'),
	envDir: process.cwd(),
	plugins: [sveltekit(), countryFlags()],
	define: {
		__BUILD_DATE__: JSON.stringify(getBuildDate()),
		__COMMIT_HASH__: JSON.stringify(getCommitHash()),
	},
	server: {
		...(() => {
			const keyPath = process.env['VITE_SSL_KEY'];
			const certPath = process.env['VITE_SSL_CERT'];
			if (keyPath && certPath && fs.existsSync(keyPath) && fs.existsSync(certPath)) return { https: { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) } };
			if (fs.existsSync(path.resolve(__dirname, 'server.key'))) return { https: { key: fs.readFileSync(path.resolve(__dirname, 'server.key')), cert: fs.readFileSync(path.resolve(__dirname, 'server.crt')) } };
			if (fs.existsSync(path.resolve(__dirname, 'certs/server.key'))) return { https: { key: fs.readFileSync(path.resolve(__dirname, 'certs/server.key')), cert: fs.readFileSync(path.resolve(__dirname, 'certs/server.crt')) } };
			return {};
		})(),
		allowedHosts: true,
		host: true,
		port: 6003,
		// The backend owns CORS for /status; Vite's own middleware would answer the preflight itself.
		cors: false,
		proxy: {
			'/ws': {
				target: getBackendProxyTarget(),
				ws: true,
			},
			// The query (with the token and any duplicate of it) goes through untouched, so the
			// backend decides; a redirect is returned to the client, never followed.
			'^/status($|[?])': {
				target: getBackendStatusTarget(),
				followRedirects: false,
			},
		},
		fs: {
			allow: [__dirname, path.resolve(__dirname, '..')],
		},
		watch: {
			usePolling: true,
		},
	},
});
