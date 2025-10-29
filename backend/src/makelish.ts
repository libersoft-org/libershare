import { Utils } from './utils.ts';
import { createManifest, SUPPORTED_ALGOS, HashAlgorithm, DEFAULT_CHUNK_SIZE, DEFAULT_ALGO } from './lish.ts';
interface IArgs {
	input?: string;
	name?: string;
	chunk?: number;
	output?: string;
	algo?: string;
	description?: string;
	threads?: number;
}
const DEFAULT_OUTPUT = 'output.lish';

function showHelp() {
	console.log('Usage: ./makelish.sh --input <file-or-directory> --name <text> [options]');
	console.log('');
	console.log('Options:');
	console.log('  --input <path>          Input file or directory (required)');
	console.log('  --output <path>         Output LISH file (default: output.lish)');
	console.log('  --name <text>           Manifest name (required)');
	console.log('  --description <text>    Optional description for the manifest');
	console.log('  --chunk <size>          Chunk size (default: 5M). Supports: K, M, G, T (multiples of 1024)');
	console.log('                          Examples: 512K, 5M, 1G, 2T or raw bytes: 5242880');
	console.log('  --algo <algorithm>      Hash algorithm (default: sha256)');
	console.log('  --threads <number>      Number of worker threads (default: 1, use 0 for auto detection by number of CPU cores)');
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
	};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		const key = argMap[arg];
		if (key && i + 1 < args.length) {
			const value = args[++i];
			if (key === 'chunk') (parsed as any)[key] = Utils.parseBytes(value);
			else if (key === 'threads') (parsed as any)[key] = parseInt(value, 10);
			else (parsed as any)[key] = value;
		}
	}
	return parsed;
}

async function main() {
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
	if (!args.name) {
		showHelp();
		console.log();
		console.error('Error: --name parameter is required');
		process.exit(1);
	}
	const inputPath = args.input;
	const name = args.name;
	const outputFile = args.output || DEFAULT_OUTPUT;
	const chunkSize = args.chunk || DEFAULT_CHUNK_SIZE;
	const algo = (args.algo || DEFAULT_ALGO) as HashAlgorithm;
	const description = args.description;
	const threads = args.threads !== undefined ? args.threads : 1;
	const actualThreads = threads === 0 ? navigator.hardwareConcurrency || 4 : threads;
	if (!SUPPORTED_ALGOS.includes(algo as any)) {
		console.error('Error: Unsupported algorithm "' + algo + '"');
		console.error('Supported algorithms: ' + SUPPORTED_ALGOS.join(', '));
		process.exit(1);
	}
	try {
		// Get input stats
		const file = Bun.file(inputPath);
		const stat = await file.stat();
		const inputType = stat.isDirectory() ? 'directory' : 'file';
		const sizeInfo = stat.isFile() ? Utils.formatBytes(stat.size) : '';
		const startTime = Date.now();
		console.log('\x1b[33mStart time:\x1b[0m           ' + new Date().toLocaleString());
		console.log('');
		if (sizeInfo) console.log('\x1b[33mSize:\x1b[0m ' + sizeInfo);
		console.log('\x1b[33mName:\x1b[0m                 ' + name);
		if (description) console.log('\x1b[33mDescription:\x1b[0m          ' + description);
		console.log('\x1b[33mProcessing ' + inputType + ':\x1b[0m ' + inputPath);
		console.log('\x1b[33mChunk size:\x1b[0m           ' + Utils.formatBytes(chunkSize));
		console.log('\x1b[33mChecksum algorithm:\x1b[0m   ' + algo);
		console.log('\x1b[33mThreads:\x1b[0m              ' + actualThreads + (threads === 0 ? ' (auto detect)' : ''));
		console.log('');
		// Create manifest with progress callback
		let lastProgress = '';
		let currentFile = '';
		let processedFiles = new Map<string, { size: number; chunks: number }>();
		const manifest = await createManifest(inputPath, name, chunkSize, algo, threads, description, info => {
			if (info.type === 'file-start' && info.path && info.size !== undefined && info.chunks !== undefined) {
				// Clear previous progress line if any
				if (lastProgress) {
					process.stdout.write('\n');
					lastProgress = '';
				}
				// Store file info
				currentFile = info.path;
				processedFiles.set(info.path, { size: info.size, chunks: info.chunks });
				// Show start message without newline
				lastProgress = '\x1b[33mCreating checksums:\x1b[0m   ' + info.path + ' (' + Utils.formatBytes(info.size) + ')';
				process.stdout.write(lastProgress);
			} else if (info.type === 'chunk' && info.path && info.current && info.total) {
				// Update chunk progress on same line
				const fileInfo = processedFiles.get(info.path);
				if (fileInfo) {
					const prefix = '\x1b[33mCreating checksums:\x1b[0m   ' + info.path + ' (' + Utils.formatBytes(fileInfo.size) + ')';
					lastProgress = prefix + ' - ' + info.current + '/' + info.total;
					process.stdout.write('\r' + lastProgress);
				}
			} else if (info.type === 'file' && info.path) {
				// Just add newline after progress is done
				if (lastProgress) {
					process.stdout.write('\n');
					lastProgress = '';
				}
			}
		});
		// Write chunk progress newline if we were processing a single file
		if (lastProgress) process.stdout.write('\n');
		await Bun.write(Utils.instantiateFilenameTemplate(outputFile, { 'UUID': manifest.id } ), JSON.stringify(manifest, null, 2));
		const endTime = Date.now();
		const elapsedSeconds = Math.floor((endTime - startTime) / 1000);
		const hours = Math.floor(elapsedSeconds / 3600);
		const minutes = Math.floor((elapsedSeconds % 3600) / 60);
		const seconds = elapsedSeconds % 60;
		const timeStr = hours.toString().padStart(2, '0') + ':' + minutes.toString().padStart(2, '0') + ':' + seconds.toString().padStart(2, '0');
		const lishFile = Bun.file(outputFile);
		const lishSize = lishFile.size;
		console.log('\n\x1b[33mLISH file saved to:\x1b[0m   ' + outputFile + ' (' + Utils.formatBytes(lishSize) + ')');
		// Summary
		const fileCount = manifest.files?.length || 0;
		const dirCount = manifest.directories?.length || 0;
		const linkCount = manifest.links?.length || 0;
		const totalSize = manifest.files?.reduce((sum, file) => sum + file.size, 0) || 0;
		console.log('\x1b[33mSummary:\x1b[0m              ' + fileCount + ' files, ' + dirCount + ' directories, ' + linkCount + ' links');
		console.log('\x1b[33mTotal size:\x1b[0m           ' + Utils.formatBytes(totalSize));
		console.log('');
		console.log('\x1b[33mEnd time:\x1b[0m             ' + new Date().toLocaleString());
		console.log('\x1b[33mElapsed time:\x1b[0m         ' + timeStr);
	} catch (error) {
		console.error('Error:', error);
		process.exit(1);
	}
}

main();
