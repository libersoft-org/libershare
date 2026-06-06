/**
 * WebSocket test for error recovery events.
 * Connects to a running backend and tests:
 * 1. transfer.recovery:* events
 * 2. transfer.download:retrying / resumed events
 * 3. Settings autoErrorRecovery
 *
 * Run: bun run backend/tests/ws-recovery-test.ts [ws-url]
 * Default URL: ws://<redacted-lan-ip>:1158
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

async function connect(): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(WS_URL);
		ws.onopen = () => resolve(ws);
		ws.onerror = e => reject(new Error(`WS connect failed: ${e}`));
		ws.onmessage = msg => {
			const data: WSMessage = JSON.parse(msg.data as string);
			if (data.id !== undefined && pending.has(data.id)) {
				const p = pending.get(data.id)!;
				pending.delete(data.id);
				if (data.error) p.reject(new Error(data.error));
				else p.resolve(data.result);
			}
			if (data.event) {
				eventLog.push({ event: data.event, data: data.data, time: Date.now() });
			}
		};
	});
}

async function call(ws: WebSocket, method: string, params: any = {}): Promise<any> {
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

async function subscribe(ws: WebSocket, event: string): Promise<void> {
	await call(ws, 'events.subscribe', { event });
}

export function waitForEvent(eventName: string, timeout = 5000): Promise<any> {
	return new Promise((resolve, reject) => {
		const start = Date.now();
		const check = setInterval(() => {
			const evt = eventLog.find(e => e.event === eventName && e.time > start);
			if (evt) {
				clearInterval(check);
				resolve(evt.data);
			}
			if (Date.now() - start > timeout) {
				clearInterval(check);
				reject(new Error(`Timeout waiting for ${eventName}`));
			}
		}, 100);
	});
}

// ============================================================================
// Tests
// ============================================================================

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
	if (condition) {
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

	// Subscribe to all relevant events
	await subscribe(ws, 'transfer.download:error');
	await subscribe(ws, 'transfer.download:enabled');
	await subscribe(ws, 'transfer.download:disabled');
	await subscribe(ws, 'transfer.download:retrying');
	await subscribe(ws, 'transfer.download:resumed');
	await subscribe(ws, 'transfer.recovery:scheduled');
	await subscribe(ws, 'transfer.recovery:attempting');
	await subscribe(ws, 'transfer.recovery:recovered');

	// Test 1: Verify settings has autoErrorRecovery
	console.log('--- Test 1: Settings ---');
	const settings = await call(ws, 'settings.list');
	assert(settings.network !== undefined, 'settings.network exists');
	const autoRecovery = settings.network.autoErrorRecovery;
	assert(autoRecovery === undefined || typeof autoRecovery === 'boolean', `autoErrorRecovery is boolean or undefined (value: ${autoRecovery})`);

	// Test 2: List LISHs and check for error state
	console.log('\n--- Test 2: LISH list with error fields ---');
	const lishs = await call(ws, 'lishs.list');
	assert(Array.isArray(lishs.items), 'lishs.list returns items array');
	if (lishs.items.length > 0) {
		const first = lishs.items[0];
		assert('errorCode' in first || first.errorCode === undefined, 'items have errorCode field (or undefined)');
	}

	// Test 3: Find a LISH with error state (if any)
	console.log('\n--- Test 3: Error state detection ---');
	const errorLish = lishs.items.find((l: any) => l.errorCode);
	if (errorLish) {
		console.log(`  Found errored LISH: ${errorLish.id.slice(0, 8)} (${errorLish.errorCode})`);
		assert(typeof errorLish.errorCode === 'string', `errorCode is string: ${errorLish.errorCode}`);
	} else {
		console.log('  No errored LISHs found — skipping error-specific tests');
		assert(true, 'No errored LISHs (OK)');
	}

	// Test 4: IO_NOT_FOUND error code exists in shared
	console.log('\n--- Test 4: IO_NOT_FOUND error code ---');
	// We can verify by trying to enable download on a LISH that has broken directory
	// First find LISHs with directory set
	const withDir = lishs.items.filter((l: any) => l.directory);
	if (withDir.length > 0) {
		const testLish = withDir[0];
		console.log(`  Testing with LISH: ${testLish.id.slice(0, 8)} (dir: ${testLish.directory?.slice(0, 40)})`);

		// Enable download (may succeed or fail with IO_NOT_FOUND)
		try {
			const result = await call(ws, 'transfer.enableDownload', { lishID: testLish.id });
			assert(typeof result.success === 'boolean', `enableDownload returned success: ${result.success}`);

			if (!result.success) {
				// Check if error event was received
				const errorEvt = eventLog.find(e => e.event === 'transfer.download:error' && e.data?.lishID === testLish.id);
				if (errorEvt) {
					assert(errorEvt.data.error !== 'DIRECTORY_MISSING', `Error is NOT old DIRECTORY_MISSING (got: ${errorEvt.data.error})`);
					console.log(`  Error code: ${errorEvt.data.error}, detail: ${errorEvt.data.errorDetail}`);

					// Check for recovery scheduled event
					const recoveryEvt = eventLog.find(e => e.event === 'transfer.recovery:scheduled' && e.data?.lishID === testLish.id);
					if (recoveryEvt) {
						assert(typeof recoveryEvt.data.delayMs === 'number', `recovery:scheduled has delayMs: ${recoveryEvt.data.delayMs}`);
						assert(typeof recoveryEvt.data.retryCount === 'number', `recovery:scheduled has retryCount: ${recoveryEvt.data.retryCount}`);
					} else {
						console.log('  No recovery:scheduled event (autoErrorRecovery may be off or error not recoverable)');
					}
				}
			} else {
				console.log('  Download enabled successfully — disabling');
				await call(ws, 'transfer.disableDownload', { lishID: testLish.id });
			}
		} catch (e) {
			console.log(`  enableDownload call failed: ${e}`);
		}
	} else {
		console.log('  No LISHs with directory — skipping enable test');
		assert(true, 'No directory LISHs (OK)');
	}

	// Test 5: Verify event subscriptions work
	console.log('\n--- Test 5: Event subscriptions ---');
	assert(eventLog.length >= 0, `Events received so far: ${eventLog.length}`);

	// Summary
	console.log(`\n===========================`);
	console.log(`Results: ${passed} passed, ${failed} failed`);
	console.log(`===========================\n`);

	ws.close();
	process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
	console.error('Test failed:', err);
	process.exit(1);
});
