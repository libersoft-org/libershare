import { afterAll, expect, it } from 'bun:test';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';

const repo = resolve(import.meta.dir, '../../../..');
const roots: string[] = [];

it('every app and helper compilation embeds both native workers', () => {
	for (const path of ['backend/build.sh', 'backend/build.bat', 'app/build-steps.sh', 'app/build.bat', 'docker/Dockerfile']) {
		const commands = readFileSync(join(repo, path), 'utf8')
			.replace(/\\\r?\n/g, ' ')
			.split(/\r?\n/)
			.filter(line => /bun build .*src\/(?:app|network-helper)\.ts(?:\s|$)/.test(line));
		expect(commands.length, path).toBeGreaterThan(0);
		for (const command of commands) {
			expect(command, path).toContain('src/native/worker-runtime.ts');
			expect(command, path).toContain('src/system-network-corewlan-worker.js');
			expect(command, path).toContain('LISH_NATIVE_WORKER_ENTRY=');
			expect(command, path).toContain('LISH_COREWLAN_WORKER_ENTRY=');
		}
	}
});

it.skipIf(!Bun.which('bsdtar') || !Bun.which('xz'))('Pacman payload paths do not start with the metadata dot prefix', () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), 'lish-pacman-gate-')));
	roots.push(root);
	const staging = join(root, 'staging'),
		work = join(root, 'work'),
		output = join(root, 'output');
	for (const path of [join(staging, 'usr/bin'), work, output]) mkdirSync(path, { recursive: true });
	writeFileSync(join(staging, 'usr/bin/demo'), 'payload');
	const result = Bun.spawnSync(['sh', '-c', '. "$1"; _build_pacman', 'sh', join(repo, 'app/build-packages.sh')], {
		env: { ...process.env, PKG_STAGING: staging, WORK: work, FINAL_DIR: output, PRODUCT_NAME_LOWER: 'demo', PRODUCT_NAME: 'Demo', PRODUCT_VERSION: '0.0.1', PRODUCT_WEBSITE: 'https://example.invalid', PKG_PACMAN_ARCH: 'x86_64', XZ_FLAGS: '-0' },
		stdout: 'pipe',
		stderr: 'pipe',
	});
	expect(result.exitCode, result.stderr.toString()).toBe(0);
	const archive = Bun.spawnSync(['bsdtar', '-tf', join(output, 'demo-0.0.1-1-x86_64.pkg.tar.xz')], { stdout: 'pipe', stderr: 'pipe' });
	expect(archive.exitCode, archive.stderr.toString()).toBe(0);
	const entries = archive.stdout.toString().trim().split('\n');
	expect(entries).toContain('.PKGINFO');
	expect(entries).toContain('.MTREE');
	expect(entries).toContain('usr/bin/demo');
	expect(entries.some(path => path.startsWith('./'))).toBe(false);
});
afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function build(failure: string): { code: number; output: string; packaged: boolean; zipInvoked: boolean } {
	const root = realpathSync(mkdtempSync(join(tmpdir(), 'lish-app-gate-')));
	roots.push(root);
	const shellRoot = root.split('\\').join('/');
	for (const dir of ['app/icons', 'app/bundle-scripts', 'backend', 'frontend/build', 'shared/src', 'bin']) mkdirSync(join(root, dir), { recursive: true });
	for (const name of ['build.sh', 'build-steps.sh', 'build-packages.sh']) copyFileSync(join(repo, 'app', name), join(root, 'app', name));
	writeFileSync(join(root, 'app/icons/icon.png'), 'cached fixture');
	writeFileSync(join(root, 'frontend/build/index.html'), 'cached fixture');
	writeFileSync(join(root, 'app/Cargo.toml'), '[package]\nversion = "0.0.1"\n');
	writeFileSync(join(root, 'shared/src/product.json'), '{}');
	writeFileSync(join(root, 'app/bundle-scripts/debug.sh'), '#!/bin/sh\n');
	const script = (name: string, body: string): void => {
		const path = join(root, name);
		writeFileSync(path, `#!/bin/sh\n${body}\n`);
		chmodSync(path, 0o755);
	};
	script('backend/build.sh', 'exit 0');
	script('bin/bun', 'exit 0');
	script('bin/rustup', 'exit 0');
	script('bin/jq', 'case "$2" in .name) echo Demo ;; .version) echo 0.0.1 ;; .identifier) echo org.example.demo ;; *) echo https://example.invalid ;; esac');
	script(
		'bin/cargo',
		`count=0
[ ! -f '${shellRoot}/cargo-count' ] || count=$(cat '${shellRoot}/cargo-count')
count=$((count + 1))
printf '%s' "$count" > '${shellRoot}/cargo-count'
if [ "$FAIL_STAGE" = compile ] && [ "$count" = 1 ]; then exit 23; fi
if [ "$FAIL_STAGE" = sign ] && [ "$count" = 2 ]; then exit 24; fi
if [ "$count" = 2 ] && [ "$FAIL_STAGE" != copy ]; then
 mkdir -p '${shellRoot}/app/build/aarch64-apple-darwin/release/bundle/macos/Demo.app'
 printf 'app' > '${shellRoot}/app/build/aarch64-apple-darwin/release/bundle/macos/Demo.app/binary'
fi
exit 0`
	);
	script(
		'bin/zip',
		`printf 'called' > '${shellRoot}/zip-called'
[ "$FAIL_STAGE" != zip ] || exit 25
printf 'archive' > "$3"`
	);
	const env = { ...process.env, APPLE_SIGNING_IDENTITY: '', FAIL_STAGE: failure, PATH: [join(root, 'bin'), dirname(Bun.which('sh')!), process.env['PATH']].join(delimiter) };
	const result = Bun.spawnSync(['sh', join(root, 'app/build.sh'), '--docker-inner', '--inner-os', 'macos', '--inner-arch', 'aarch64', '--format', 'zip'], { cwd: root, env, stdout: 'pipe', stderr: 'pipe' });
	const results = join(root, 'app/build/release/bundle/.build-results-macos-aarch64');
	return { code: result.exitCode, output: result.stdout.toString() + result.stderr.toString() + (existsSync(results) ? readFileSync(results, 'utf8') : ''), packaged: existsSync(join(root, 'app/build/release/bundle/Demo_0.0.1_macos_aarch64.zip')), zipInvoked: existsSync(join(root, 'zip-called')) };
}

for (const stage of ['compile', 'sign', 'copy', 'zip']) {
	it(`reports failure when the macOS ${stage} step fails`, () => {
		const result = build(stage);
		expect(result.code).not.toBe(0);
		expect(result.output).toContain('FAIL zip');
		expect(result.output).not.toContain('OK zip');
		expect(result.packaged).toBe(false);
		expect(result.zipInvoked).toBe(stage === 'zip');
	});
}

it('reports success after every macOS packaging step succeeds', () => {
	const result = build('none');
	expect(result.code).toBe(0);
	expect(result.output).toContain('OK zip');
	expect(result.packaged).toBe(true);
});
