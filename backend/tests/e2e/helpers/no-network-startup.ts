import { Network } from '../../../src/protocol/network.ts';

// A regressed token gate must fail this negative test before reaching the host network.
function forbidden(): never {
	throw new Error('Network access forbidden in the negative startup test');
}

Network.prototype.start = async (): Promise<void> => forbidden();
Bun.serve = forbidden;
globalThis.fetch = Object.assign(async (): Promise<Response> => forbidden(), { preconnect: forbidden });

await import('../../../src/app.ts');
