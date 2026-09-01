import { dirname, join } from 'node:path';
import { expectedNetworkHelperHash } from './network-helper-integrity.ts';
import { runElevatedWindowsProcess, verifyWindowsInstalledHelper, windowsHelperParameters } from './network-helper-windows.ts';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--request') throw new Error('invalid network launcher arguments');
const request = args[1]!;
const helper = join(dirname(process.execPath), 'lish-network-helper.exe');
const expectedHash = expectedNetworkHelperHash();
if (!expectedHash || !(await verifyWindowsInstalledHelper(helper, process.execPath, expectedHash))) throw new Error('network helper is not trusted');
process.exitCode = await runElevatedWindowsProcess(helper, windowsHelperParameters(request), 180_000);
