import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const inbox = join(process.env['SystemRoot']!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const modern = process.env['WINDOWS_ORACLE_PWSH'];
const scripts = {
	startup: "[Console]::Out.WriteLine('started'); [Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString(); $PSVersionTable.PSVersion.ToString()",
	network: "[Console]::Out.WriteLine('started'); $ErrorActionPreference='Stop'; @(Get-NetAdapter -IncludeHidden).Count; [Console]::Out.WriteLine('completed')",
};

for (const executable of [inbox, ...(modern ? [modern] : [])]) {
	const bytes = readFileSync(executable);
	console.log(JSON.stringify({ executable, machine: bytes.readUInt16LE(bytes.readUInt32LE(0x3c) + 4).toString(16), bun: Bun.version, arch: process.arch }));
	for (const [script, body] of Object.entries(scripts)) {
		for (const input of ['ignore', 'open', 'closed'] as const) {
			const started = performance.now();
			const child = Bun.spawn([executable, '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(body, 'utf16le').toString('base64')], { stdin: input === 'ignore' ? 'ignore' : 'pipe', stdout: 'pipe', stderr: 'pipe' });
			if (input === 'closed' && child.stdin && typeof child.stdin !== 'number') child.stdin.end();
			let expired = false;
			const timer = setTimeout(() => {
				expired = true;
				child.kill('SIGKILL');
			}, 8000);
			try {
				const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
				console.log(JSON.stringify({ executable, script, input, code, expired, ms: Math.round(performance.now() - started), output: output.trim(), error: error.trim().slice(0, 800) }));
			} finally {
				clearTimeout(timer);
			}
		}
	}
}
