import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

/**
 * Run every browser fixture in headless Chrome and fail unless each reports `data-test-status="passed"`.
 * Chrome comes from CHROME_BIN, else the usual install location of the platform. The page runs in real
 * time (fixtures wait on timers), and its status is polled through the DevTools protocol.
 */
const chrome = process.env['CHROME_BIN'] ?? (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome');
const FIXTURE_TIMEOUT_MS = 120_000;
const directory = fileURLToPath(new URL('.', import.meta.url));
const fixtures = readdirSync(directory)
	.filter(name => name.endsWith('.html'))
	.sort();
const server = await createServer({ configFile: fileURLToPath(new URL('vite.config.ts', import.meta.url)), logLevel: 'error', server: { port: 0, strictPort: false } });
await server.listen();
const address = server.httpServer?.address();
if (!address || typeof address === 'string') throw new Error('The fixture server did not start');
const serverPort = address.port;

/** Open one fixture and wait until it sets its status; `timeout` when it never does. */
async function runFixture(name: string): Promise<string> {
	const profile = mkdtempSync(join(tmpdir(), 'lish-fixture-chrome-'));
	const browser = Bun.spawn([chrome, '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, `http://127.0.0.1:${serverPort}/tests/browser/${name}`], { stdout: 'ignore', stderr: 'ignore' });
	const deadline = Date.now() + FIXTURE_TIMEOUT_MS;
	try {
		const portFile = join(profile, 'DevToolsActivePort');
		while (!existsSync(portFile) || !readFileSync(portFile, 'utf8').includes('\n')) {
			if (Date.now() > deadline) return 'timeout';
			await Bun.sleep(100);
		}
		const port = readFileSync(portFile, 'utf8').split('\n')[0];
		let page: { webSocketDebuggerUrl: string } | undefined;
		while (!page) {
			if (Date.now() > deadline) return 'timeout';
			const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[];
			page = targets.find(target => target.type === 'page' && target.url.includes(name));
			if (!page) await Bun.sleep(100);
		}
		const socket = new WebSocket(page.webSocketDebuggerUrl);
		await new Promise((resolve, reject) => {
			socket.onopen = resolve;
			socket.onerror = reject;
		});
		let id = 0;
		const evaluate = (expression: string): Promise<unknown> =>
			new Promise(resolve => {
				const current = ++id;
				const onMessage = (event: MessageEvent): void => {
					const message = JSON.parse(String(event.data));
					if (message.id !== current) return;
					socket.removeEventListener('message', onMessage);
					resolve(message.result?.result?.value);
				};
				socket.addEventListener('message', onMessage);
				socket.send(JSON.stringify({ id: current, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
			});
		try {
			while (Date.now() < deadline) {
				const status = await evaluate('document.documentElement.dataset.testStatus ?? ""');
				if (status) return String(status);
				await Bun.sleep(250);
			}
			return 'timeout';
		} finally {
			socket.close();
		}
	} finally {
		browser.kill();
		await browser.exited;
		rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
	}
}

let failed = 0;
try {
	for (const name of fixtures) {
		const status = await runFixture(name);
		console.log(`${status === 'passed' ? 'PASS' : 'FAIL'} ${name}${status === 'passed' ? '' : ` (${status})`}`);
		if (status !== 'passed') failed++;
	}
} finally {
	await server.close();
}
console.log(`${fixtures.length - failed}/${fixtures.length} browser fixtures passed`);
process.exit(failed ? 1 : 0);
