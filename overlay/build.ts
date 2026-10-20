// Builds lish-overlay against Nebula with the lighthouse "hide_addresses" patch (patches/).
//
//   bun build.ts prepare                         patched Nebula source in .nebula/ (go.mod replaces the module with it)
//   bun build.ts                                 binary for this machine: build/lish-overlay[.exe]
//   bun build.ts linux/arm64 windows/amd64 ...   cross builds: build/lish-overlay-<os>-<arch>[.exe]
//   bun build.ts --out <file> <os>/<arch>        one target to an exact path (the app build)
//
// Needs Go (any version from 1.21 on fetches the toolchain go.mod asks for) and git.
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const NEBULA_VERSION = 'v1.11.2';
const here = import.meta.dir;
const nebulaDir = join(here, '.nebula');
const marker = join(nebulaDir, `.patched-${NEBULA_VERSION}`);

function run(cmd: string[], cwd: string = here, env: Record<string, string> = {}): string {
	const proc = Bun.spawnSync(cmd, { cwd, env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' });
	if (proc.exitCode !== 0) throw new Error(`${cmd.join(' ')} failed:\n${proc.stderr.toString()}${proc.stdout.toString()}`);
	return proc.stdout.toString().trim();
}

function makeWritable(dir: string): void {
	for (const entry of new Bun.Glob('**/*').scanSync({ cwd: dir, onlyFiles: false, dot: true })) chmodSync(join(dir, entry), 0o755);
	chmodSync(dir, 0o755);
}

function prepare(): void {
	if (existsSync(marker)) return;
	run(['go', 'mod', 'download', `github.com/slackhq/nebula@${NEBULA_VERSION}`]);
	const source = join(run(['go', 'env', 'GOMODCACHE']), `github.com/slackhq/nebula@${NEBULA_VERSION}`);
	if (existsSync(nebulaDir)) {
		makeWritable(nebulaDir);
		rmSync(nebulaDir, { recursive: true });
	}
	cpSync(source, nebulaDir, { recursive: true });
	makeWritable(nebulaDir); // the module cache is read-only
	const patch = join(here, 'patches', 'nebula-hide-addresses.patch');
	// Inside a git checkout, `git apply` resolves patch paths from the repository root and silently skips files
	// outside it; --directory points it at .nebula/ from there. Outside a checkout it applies where it runs.
	let top = '';
	try {
		top = run(['git', 'rev-parse', '--show-toplevel']);
	} catch {}
	if (top) run(['git', 'apply', '-p1', `--directory=${relative(resolve(top), nebulaDir).replaceAll('\\', '/')}`, patch], top);
	else run(['git', 'apply', '-p1', patch], nebulaDir);
	if (!readFileSync(join(nebulaDir, 'lighthouse.go'), 'utf8').includes('hideAddresses')) throw new Error('the hide-addresses patch did not apply');
	writeFileSync(marker, '');
	console.log(`patched Nebula ${NEBULA_VERSION} in .nebula/`);
}

function build(target: string, out: string): void {
	const [goos, goarch] = target.split('/');
	if (!goos || !goarch) throw new Error(`target must be <os>/<arch>, got ${target}`);
	let version = 'dev';
	try {
		version = JSON.parse(readFileSync(join(here, '..', 'shared', 'src', 'product.json'), 'utf8')).version;
	} catch {}
	mkdirSync(dirname(out), { recursive: true });
	run(['go', 'build', '-trimpath', '-ldflags', `-s -w -X main.version=${version}`, '-o', out, '.'], here, { CGO_ENABLED: '0', GOOS: goos, GOARCH: goarch });
	console.log(`built ${out}`);
}

const args = process.argv.slice(2);
prepare();
if (args[0] === 'prepare') process.exit(0);
const ext = (os: string): string => (os === 'windows' ? '.exe' : '');
if (args[0] === '--out') {
	const [, out, target] = args;
	if (!out || !target) throw new Error('usage: bun build.ts --out <file> <os>/<arch>');
	build(target, resolve(out));
} else if (args.length === 0) {
	const goos = run(['go', 'env', 'GOOS']);
	build(`${goos}/${run(['go', 'env', 'GOARCH'])}`, join(here, 'build', `lish-overlay${ext(goos)}`));
} else {
	for (const target of args) {
		const goos = target.split('/')[0]!;
		build(target, join(here, 'build', `lish-overlay-${target.replace('/', '-')}${ext(goos)}`));
	}
}
