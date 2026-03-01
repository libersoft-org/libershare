import { SUPPORTED_ALGOS, type HashAlgorithm, DEFAULT_ALGO, DEFAULT_CHUNK_SIZE, DEFAULT_API_URL, formatBytes, parseBytes, API } from '@shared';
import { APIClient } from './api-client.ts';
interface IArgs {
	input?: string;
	name?: string;
	chunk?: number;
	output?: string;
	algo?: string;
	description?: string;
	threads?: number;
	url?: string;
	addToSharing?: boolean;
	minifyJson?: boolean;
	compressGzip?: boolean;
}

function showHelp(): void {
	console.log('Usage: ./makelish.sh --input <file-or-directory> [options]');
	console.log('');
	console.log('Options:');
	console.log('  --input <path>          Input file or directory (required)');
	console.log('  --output <path>         Output LISH file (optional, default: [NAME].lish if --name provided, otherwise [UUID].lish)');
	console.log('                          Supports placeholders: [UUID], [NAME]');
	console.log('                          [UUID] will be replaced with LISH UUID');
	console.log('                          [NAME] will be replaced with LISH name (requires --name)');
	console.log('  --name <text>           LISH name (optional)');
	console.log('  --description <text>    Description for the LISH (optional)');
	console.log('  --chunk <size>          Chunk size (optional, default: 1M), supports: K, M, G, T (multiples of 1024)');
	console.log('                          Examples: 512K, 5M, 1G, 2T or raw bytes: 5242880');
	console.log('  --algo <algorithm>      Hash algorithm (optional, default: sha256)');
	console.log('  --threads <number>      Number of worker threads (optional, default: 0 = auto detect by CPU cores)');
	console.log('  --url <url>             Backend WebSocket URL (optional, default: ' + DEFAULT_API_URL + ')');
	console.log('  --add-to-sharing        Add to sharing after creation (default: false)');
	console.log('  --minify-json           Minify JSON output (default: false)');
	console.log('  --compress-gzip         Compress LISH file with gzip (default: false)');
	console.log('  --help                  Show this help message');
	console.log('');
	console.log('Supported algorithms:');
	console.log('  ' + SUPPORTED_ALGOS.join(', '));
	console.log('');
	console.log('Examples:');
	console.log('  ./makelish.sh --input myfile.bin --name "Project documentation"');
	console.log('  ./makelish.sh --input ./mydir --output project.lish --name "Project documentation" --algo sha512');
	console.log('  ./makelish.sh --input data.zip --name "Project documentation" --chunk 1M --description "User manual and guides - created by John Doe"');
	console.log('  ./makelish.sh --input bigfile.iso --name "ISO image" --threads 8 --chunk 50M');
	console.log('  ./makelish.sh --input data.zip --output [UUID].lish --name "Archive" --description "File with UUID in filename"');
	console.log('  ./makelish.sh --input ./docs --output [NAME]-[UUID].lish --name "Documentation" --description "File with name and UUID"');
	console.log('  ./makelish.sh --input ./data --url ws://192.168.1.10:1158 --name "Remote server data"');
}

function parseArgs(args: string[]): IArgs {
	const parsed: IArgs = {};
	const argMap: Record<string, keyof IArgs> = {
		'--input': 'input',
		'--output': 'output',
		'--name': 'name',
		'--chunk': 'chunk',
		'--algo': 'algo',
		'--description': 'description',
		'--threads': 'threads',
		'--url': 'url',
	};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === '--add-to-sharing') {
			parsed.addToSharing = true;
			continue;
		}
		if (arg === '--minify-json') {
			parsed.minifyJson = true;
			continue;
		}
		if (arg === '--compress-gzip') {
			parsed.compressGzip = true;
			continue;
		}
		const key = argMap[arg];
		if (key && i + 1 < args.length) {
			const value = args[++i]!;
			if (key === 'chunk') (parsed as any)[key] = parseBytes(value!);
			else if (key === 'threads') (parsed as any)[key] = parseInt(value!, 10);
			else (parsed as any)[key] = value;
		}
	}
	return parsed;
}

async function main(): Promise<void> {
	console.log('');
	console.log('=================');
	console.log('LISH file creator');
	console.log('=================');
	console.log('');
	const args = parseArgs(Bun.argv.slice(2));
	if (Bun.argv.includes('--help')) {
		showHelp();
		process.exit(0);
	}
	if (!args.input) {
		showHelp();
		console.log();
		console.error('Error: --input parameter is required');
		process.exit(1);
	}
	const algo = (args.algo || DEFAULT_ALGO) as HashAlgorithm;
	if (!SUPPORTED_ALGOS.includes(algo as any)) {
		console.error('Error: Unsupported algorithm "' + algo + '"');
		console.error('Supported algorithms: ' + SUPPORTED_ALGOS.join(', '));
		process.exit(1);
	}
	try {
		await makeLISH(args);
	} catch (error) {
		console.error('Error:', error);
		process.exit(1);
	}
}

interface LISHProgressEvent {
	type: 'file-list' | 'file-start' | 'chunk' | 'file';
	path?: string;
	current?: number;
	total?: number;
	size?: number;
	chunks?: number;
	files?: { path: string; size: number; chunks: number }[];
}

async function makeLISH(args: IArgs): Promise<void> {
	const inputPath = args.input!;
	const name = args.name;
	const chunkSize = args.chunk || DEFAULT_CHUNK_SIZE;
	const algo = (args.algo || DEFAULT_ALGO) as HashAlgorithm;
	const description = args.description;
	const threads = args.threads !== undefined ? args.threads : 0;
	const serverUrl = args.url || DEFAULT_API_URL;
	const addToSharing = args.addToSharing || false;
	const minifyJson = args.minifyJson || false;
	const compressGzip = args.compressGzip || false;
	const lishFile = args.output;

	const startTime = Date.now();
	console.log('\x1b[33mStart time:\x1b[0m           ' + new Date().toLocaleString());
	console.log('');
	if (name) console.log('\x1b[33mName:\x1b[0m                 ' + name);
	if (description) console.log('\x1b[33mDescription:\x1b[0m          ' + description);
	console.log('\x1b[33mData path:\x1b[0m            ' + inputPath);
	if (lishFile) console.log('\x1b[33mOutput file:\x1b[0m          ' + lishFile);
	console.log('\x1b[33mChunk size:\x1b[0m           ' + formatBytes(chunkSize));
	console.log('\x1b[33mChecksum algorithm:\x1b[0m   ' + algo);
	console.log('\x1b[33mThreads:\x1b[0m              ' + threads + (threads === 0 ? ' (auto detect)' : ''));
	console.log('\x1b[33mServer:\x1b[0m               ' + serverUrl);
	if (addToSharing) console.log('\x1b[33mAdd to sharing:\x1b[0m       yes');
	if (minifyJson) console.log('\x1b[33mMinify JSON:\x1b[0m          yes');
	if (compressGzip) console.log('\x1b[33mCompress gzip:\x1b[0m        yes');
	console.log('');

	// Connect to backend via WebSocket
	console.log('Connecting to ' + serverUrl + '...');
	const client = new APIClient(serverUrl);
	await client.connect();
	const api = new API(client);
	console.log('Connected.');
	console.log('');

	// Track progress
	let lastProgress = '';
	const processedFiles = new Map<string, { size: number; chunks: number }>();

	const handleProgress = (info: LISHProgressEvent): void => {
		if (info.type === 'file-start' && info.path && info.size !== undefined && info.chunks !== undefined) {
			if (lastProgress) {
				process.stdout.write('\n');
				lastProgress = '';
			}
			processedFiles.set(info.path, { size: info.size, chunks: info.chunks });
			lastProgress = '\x1b[33mCreating checksums:\x1b[0m   ' + info.path + ' (' + formatBytes(info.size) + ')';
			process.stdout.write(lastProgress);
		} else if (info.type === 'chunk' && info.path && info.current && info.total) {
			const fileInfo = processedFiles.get(info.path);
			if (fileInfo) {
				const prefix = '\x1b[33mCreating checksums:\x1b[0m   ' + info.path + ' (' + formatBytes(fileInfo.size) + ')';
				lastProgress = prefix + ' - ' + info.current + '/' + info.total;
				process.stdout.write('\r' + lastProgress);
			}
		} else if (info.type === 'file' && info.path) {
			if (lastProgress) {
				process.stdout.write('\n');
				lastProgress = '';
			}
		}
	};

	// Subscribe to progress events
	client.on('lishs.create:progress', handleProgress);
	await api.subscribe('lishs.create:progress');

	try {
		const result = await api.lishs.create(inputPath, lishFile, addToSharing, name, description, algo, chunkSize, threads, minifyJson, compressGzip);
		if (lastProgress) process.stdout.write('\n');

		const endTime = Date.now();
		const elapsedSeconds = Math.floor((endTime - startTime) / 1000);
		const hours = Math.floor(elapsedSeconds / 3600);
		const minutes = Math.floor((elapsedSeconds % 3600) / 60);
		const seconds = elapsedSeconds % 60;
		const timeStr = hours.toString().padStart(2, '0') + ':' + minutes.toString().padStart(2, '0') + ':' + seconds.toString().padStart(2, '0');

		console.log('');
		console.log('\x1b[33mLISH ID:\x1b[0m              ' + result.lishID);
		if (result.lishFile) console.log('\x1b[33mLISH file:\x1b[0m            ' + result.lishFile);
		console.log('');
		console.log('\x1b[33mEnd time:\x1b[0m             ' + new Date().toLocaleString());
		console.log('\x1b[33mElapsed time:\x1b[0m         ' + timeStr);
		console.log('');
		console.log('\x1b[32mLISH created successfully!\x1b[0m');
	} catch (error: any) {
		if (lastProgress) process.stdout.write('\n');
		console.error('\x1b[31mError creating LISH:\x1b[0m ' + (error.message || error));
		process.exit(1);
	} finally {
		await api.unsubscribe('lishs.create:progress').catch(() => {});
		client.close();
	}
}

main();
