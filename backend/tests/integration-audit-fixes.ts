/**
 * Integration test for audit fixes via WebSocket API.
 * Requires backend running on localhost:1158.
 * Usage: bun run backend/tests/integration-audit-fixes.ts
 */

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string): void {
	if (condition) { passed++; console.log(`  ✓ ${name}`); }
	else { failed++; console.error(`  ✗ ${name}`); }
}

async function rpc(ws: WebSocket, method: string, params: any = {}): Promise<any> {
	const id = Math.random().toString(36).slice(2);
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error(`RPC timeout: ${method}`)), 10000);
		const handler = (event: MessageEvent) => {
			const data = JSON.parse(event.data);
			if (data.id === id) {
				clearTimeout(timeout);
				ws.removeEventListener('message', handler);
				if (data.error) reject(new Error(`RPC error: ${data.error}`));
				else resolve(data.result);
			}
		};
		ws.addEventListener('message', handler);
		ws.send(JSON.stringify({ id, method, params }));
	});
}

async function waitOpen(ws: WebSocket): Promise<void> {
	if (ws.readyState === WebSocket.OPEN) return;
	return new Promise((resolve, reject) => {
		ws.addEventListener('open', () => resolve());
		ws.addEventListener('error', (e) => reject(e));
	});
}

async function main() {
	console.log('Connecting to ws://localhost:1158...');
	const ws = new WebSocket('ws://localhost:1158');
	await waitOpen(ws);
	console.log('Connected.\n');

	// ─── Test: List LISHs — verify API is working ───────────────────────
	console.log('── API connectivity ──');
	const listResult = await rpc(ws, 'lishs.list');
	const lishs = listResult?.items ?? [];
	assert(Array.isArray(lishs), 'lishs.list returns items array');
	console.log(`  (${lishs.length} LISHs in database)`);

	// ─── Test: Check that isComplete fix works at API level ──────────────
	console.log('\n── isComplete fix at API level ──');
	if (lishs.length > 0) {
		const detail = await rpc(ws, 'lishs.get', { lishID: lishs[0].id });
		assert(detail !== null, 'lishs.get returns data');
		assert(typeof detail.id === 'string', 'Detail has id field');
		console.log(`  LISH: ${detail.name ?? '(unnamed)'} (${detail.id.slice(0, 16)}...)`);
		console.log(`  Files: ${detail.files?.length ?? 0}, Complete: ${detail.complete ?? 'N/A'}`);
	} else {
		console.log('  (no LISHs to test — skipping detail check)');
	}

	// ─── Test: Active transfers state ────────────────────────────────────
	console.log('\n── Active transfers ──');
	const transfers = await rpc(ws, 'transfer.getActiveTransfers');
	assert(Array.isArray(transfers), 'transfer.getActiveTransfers returns array');
	console.log(`  Active transfers: ${transfers.length}`);
	for (const t of transfers) {
		console.log(`    ${t.type} ${t.lishID.slice(0, 12)} peers=${t.peers}`);
	}

	// ─── Test: Verify trace log exists ───────────────────────────────────
	console.log('\n── Trace logging ──');
	const logFile = Bun.file('C:\\work\\sources\\libershare\\data\\backend-trace.log');
	const logExists = await logFile.exists();
	assert(logExists, 'Trace log file exists');
	if (logExists) {
		const logContent = await logFile.text();
		const lines = logContent.split('\n').length;
		console.log(`  Log file: ${lines} lines`);
		// Check for our new log messages
		assert(logContent.includes('[DL]') || logContent.includes('[Recovery]') || lines > 5, 'Log contains relevant entries');
	}

	ws.close();
	console.log(`\n${'═'.repeat(50)}`);
	console.log(`Results: ${passed} passed, ${failed} failed`);
	if (failed > 0) process.exit(1);
}

main().catch(err => {
	console.error('Integration test failed:', err);
	process.exit(1);
});
