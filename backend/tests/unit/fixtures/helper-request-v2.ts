import { resolve } from 'node:path';
import type { NetworkHelperIdentity } from '../../../src/network-helper-protocol.ts';

export const helperRequestIdentity: NetworkHelperIdentity = {
	version: 2,
	operationId: '00000000-0000-4000-8000-000000000001',
	cancelPath: resolve('helper-test.cancel'),
};
