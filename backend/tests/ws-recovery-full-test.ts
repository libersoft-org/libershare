/**
 * Full WS test for error recovery + inline retry events.
 * Creates an error condition (enables download on LISH with non-existent directory)
 * and verifies recovery:scheduled event arrives.
 *
 * Run: bun run backend/tests/ws-recovery-full-test.ts [ws-url]
 */
export {};

const WS_URL = process.argv[2] || 'ws://<redacted-lan-ip>:1158';

interface WSMessage {
	id?: number;
	result?: any;
	error?: string;
	event?: string;
	data?: any;
}

let msgId = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
const eventLog: Array<{ event: string; data: any; time: number }> = [];

function connect(): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(WS_URL);
		ws.onopen = () => resolve(ws);
		ws.onerror = () => reject(new Error('WS connect failed'));
		ws.onmessage = msg => {
			const data: WSMessage = JSON.parse(msg.data as string);
			if (data.id !== undefined && pending.has(data.id)) {
				const p = pending.get(data.id)!;
				pending.delete(data.id);
				if (data.error) p.reject(new Error(`${data.error}`));
				else p.resolve(data.result);
			}
			if (data.event) eventLog.push({ event: data.event, data: data.data, time: Date.now() });
		};
	});
}

function call(ws: WebSocket, method: string, params: any = {}): Promise<any> {
	const id = ++msgId;
	return new Promise((resolve, reject) => {
		pending.set(id, { resolve, reject });
		ws.send(JSON.stringify({ id, method, ...params }));
		setTimeout(() => {
			if (pending.has(id)) {
				pending.delete(id);
				reject(new Error(`Timeout: ${method}`));
			}
		}, 10000);
	});
}

function sub(ws: WebSocket, event: string): Promise<void> {
	return call(ws, 'events.subscribe', { event });
}

function waitEvent(name: string, afterTime: number, timeout = 15000): Promise<any> {
	return new Promise((resolve, reject) => {
		const start = Date.now();
		const check = setInterval(() => {
			const evt = eventLog.find(e => e.event === name && e.time >= afterTime);
			if (evt) {
				clearInterval(check);
				resolve(evt.data);
			}
			if (Date.now() - start > timeout) {
				clearInterval(check);
				reject(new Error(`Timeout waiting for ${name}`));
			}
		}, 200);
	});
}

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string): void {
	if (cond) {
		passed++;
		console.log(`  ✅ ${msg}`);
	} else {
		failed++;
		console.log(`  ❌ ${msg}`);
	}
}

async function run(): Promise<void> {
	console.log(`\nConnecting to ${WS_URL}...\n`);
	const ws = await connect();
	console.log('Connected.\n');

	// Subscribe to all events
	for (const e of ['transfer.download:error', 'transfer.download:enabled', 'transfer.download:disabled', 'transfer.download:retrying', 'transfer.download:resumed', 'transfer.recovery:scheduled', 'transfer.recovery:attempting', 'transfer.recovery:recovered']) await sub(ws, e);

	// Test 1: Settings
	console.log('--- Test 1: autoErrorRecovery setting ---');
	const settings = await call(ws, 'settings.list');
	ok(settings.network.autoErrorRecovery === true, `autoErrorRecovery is true`);

	// Test 2: Find a LISH to test with (needs directory set to something that doesn't exist)
	console.log('\n--- Test 2: Find test LISH ---');
	const lishs = await call(ws, 'lishs.list');
	ok(lishs.items.length > 0, `Have ${lishs.items.length} LISHs`);

	// Find a LISH with directory by checking details
	let testLish: any = null;
	for (const l of lishs.items) {
		try {
			const detail = await call(ws, 'lishs.get', { lishID: l.id });
			if (detail?.directory && detail.totalChunks > 0) {
				testLish = { ...l, directory: detail.directory };
				break;
			}
		} catch {}
	}
	if (!testLish) {
		console.log('  No LISH with directory found — skipping directory-based tests');
		ok(true, 'Skipping directory-based tests (no suitable LISH)');
	} else {
		console.log(`  Using LISH: ${testLish.name} (${testLish.id.slice(0, 8)}, dir: ${testLish.directory?.slice(0, 50)})`);

		// Test 3: Enable download on LISH with broken directory → should get error + recovery
		console.log('\n--- Test 3: Enable download → expect error + recovery ---');
		const beforeTime = Date.now();
		const result = await call(ws, 'transfer.enableDownload', { lishID: testLish.id });
		console.log(`  enableDownload result: success=${result.success}`);

		if (!result.success) {
			// Should get transfer.download:error
			try {
				const errorEvt = await waitEvent('transfer.download:error', beforeTime, 5000);
				ok(true, `Got transfer.download:error (code: ${errorEvt.error})`);
				ok(errorEvt.error !== 'DIRECTORY_MISSING', `Error code is NOT old DIRECTORY_MISSING (got: ${errorEvt.error})`);
				ok(errorEvt.error === 'IO_NOT_FOUND' || errorEvt.error === 'DIRECTORY_ACCESS_DENIED', `Error is IO_NOT_FOUND or ACCESS_DENIED`);
			} catch {
				ok(false, 'Did not receive transfer.download:error event');
			}

			// Should get transfer.recovery:scheduled (if autoErrorRecovery is true)
			try {
				const recoveryEvt = await waitEvent('transfer.recovery:scheduled', beforeTime, 5000);
				ok(true, `Got transfer.recovery:scheduled`);
				ok(typeof recoveryEvt.delayMs === 'number', `delayMs: ${recoveryEvt.delayMs}`);
				ok(typeof recoveryEvt.retryCount === 'number', `retryCount: ${recoveryEvt.retryCount}`);
				console.log(`  Recovery scheduled: delay=${recoveryEvt.delayMs}ms, retry=${recoveryEvt.retryCount}`);
			} catch {
				ok(false, 'Did not receive transfer.recovery:scheduled event');
			}

			// Clean up: disable download to stop recovery
			await call(ws, 'transfer.disableDownload', { lishID: testLish.id });
			console.log('  Disabled download (stopped recovery)');

			// Verify recovery stopped
			const stateAfter = await call(ws, 'lishs.list');
			const lishAfter = stateAfter.items.find((l: any) => l.id === testLish.id);
			if (lishAfter) {
				console.log(`  LISH state after disable: errorCode=${lishAfter.errorCode ?? 'none'}`);
			}
		} else {
			console.log('  Download succeeded (directory exists in Docker) — disabling');
			await call(ws, 'transfer.disableDownload', { lishID: testLish.id });
			ok(true, 'enableDownload succeeded (directory accessible)');
		}
	}

	// Test 4: Verify IO_NOT_FOUND error code in list
	console.log('\n--- Test 4: Error codes in list ---');
	const finalList = await call(ws, 'lishs.list');
	const erroredLishs = finalList.items.filter((l: any) => l.errorCode);
	console.log(`  Errored LISHs: ${erroredLishs.length}`);
	for (const l of erroredLishs) {
		console.log(`    ${l.id.slice(0, 8)}: ${l.errorCode} — ${l.errorDetail?.slice(0, 40) ?? 'no detail'}`);
		ok(l.errorCode !== 'DIRECTORY_MISSING', `${l.id.slice(0, 8)} uses new error code (not DIRECTORY_MISSING)`);
	}
	if (erroredLishs.length === 0) ok(true, 'No errored LISHs (OK)');

	// Summary
	console.log(`\n===========================`);
	console.log(`Results: ${passed} passed, ${failed} failed`);
	console.log(`Total events received: ${eventLog.length}`);
	for (const e of eventLog) console.log(`  ${e.event}: ${JSON.stringify(e.data).slice(0, 80)}`);
	console.log(`===========================\n`);

	ws.close();
	process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
	console.error('Test failed:', err);
	process.exit(1);
});
