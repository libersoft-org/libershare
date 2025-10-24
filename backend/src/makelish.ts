import { Utils } from './utils.ts';
import { createManifest, SUPPORTED_ALGOS, HashAlgorithm, DEFAULT_CHUNK_SIZE, DEFAULT_ALGO } from './lish.ts';
interface IArgs {
	input?: string;
	chunksize?: number;
	output?: string;
	algo?: string;
	description?: string;
}
const DEFAULT_OUTPUT = 'output.lish';

function showHelp() {
	console.log('');
	console.log('=====================');
	console.log('LISH Manifest Creator');
	console.log('=====================');
	console.log('');
	console.log('Usage: ./makelish.sh --input <file-or-directory> [options]');
	console.log('');
	console.log('Options:');
	console.log('  --input <path>          Input file or directory (required)');
	console.log('  --output <path>         Output LISH file (default: output.lish)');
	console.log('  --chunksize <bytes>     Chunk size in bytes (default: 5242880 = 5MB)');
	console.log('  --algo <algorithm>      Hash algorithm (default: sha256)');
	console.log('  --description <text>    Optional description for the manifest');
	console.log('  --help                  Show this help message');
	console.log('');
	console.log('Supported algorithms:');
	console.log('  ' + SUPPORTED_ALGOS.join(', '));
	console.log('');
	console.log('Examples:');
	console.log('  ./makelish.sh --input myfile.bin');
	console.log('  ./makelish.sh --input ./mydir --output archive.lish --algo sha512');
	console.log('  ./makelish.sh --input data.zip --chunksize 10485760 --description "Project documentation and user manual"');
}

function parseArgs(args: string[]): IArgs {
	const parsed: IArgs = {};
	const argMap: Record<string, keyof IArgs> = {
		'--input': 'input',
		'--chunksize': 'chunksize',
		'--output': 'output',
		'--algo': 'algo',
		'--description': 'description',
	};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		const key = argMap[arg];
		if (key && i + 1 < args.length) {
			const value = args[++i];
			(parsed as any)[key] = key === 'chunksize' ? parseInt(value, 10) : value;
		}
	}
	return parsed;
}

async function main() {
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
	const inputPath = args.input;
	const outputFile = args.output || DEFAULT_OUTPUT;
	const chunkSize = args.chunksize || DEFAULT_CHUNK_SIZE;
	const algo = (args.algo || DEFAULT_ALGO) as HashAlgorithm;
	const description = args.description;
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
		console.log('Start time: ' + new Date().toLocaleString());
		console.log('');
		console.log('Processing ' + inputType + ': ' + inputPath);
		if (sizeInfo) console.log('Size: ' + sizeInfo);
		console.log('Chunk size: ' + Utils.formatBytes(chunkSize));
		console.log('Algorithm: ' + algo);
		if (description) console.log('Description: ' + description);
		console.log('');
		// Create manifest with progress callback
		let lastProgress = '';
		let currentFile = '';
		let processedFiles = new Map<string, { size: number; chunks: number }>();
		const manifest = await createManifest(inputPath, chunkSize, algo, description, info => {
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
				lastProgress = 'Processing: ' + info.path + ' (' + Utils.formatBytes(info.size) + ')';
				process.stdout.write(lastProgress);
			} else if (info.type === 'chunk' && info.path && info.current && info.total) {
				// Update chunk progress on same line
				const fileInfo = processedFiles.get(info.path);
				if (fileInfo) {
					const prefix = 'Processing: ' + info.path + ' (' + Utils.formatBytes(fileInfo.size) + ')';
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
		await Bun.write(outputFile, JSON.stringify(manifest, null, 2));
		const endTime = Date.now();
		const elapsedTime = (endTime - startTime) / 1000;
		console.log('\nLISH file saved to: ' + outputFile);
		console.log('End time: ' + new Date().toLocaleString());
		console.log('Elapsed time: ' + elapsedTime.toFixed(2) + ' seconds');
		console.log('');
		// Summary
		const fileCount = manifest.files?.length || 0;
		const dirCount = manifest.directories?.length || 0;
		const linkCount = manifest.links?.length || 0;
		const totalSize = manifest.files?.reduce((sum, file) => sum + file.size, 0) || 0;
		console.log('Summary: ' + fileCount + ' files, ' + dirCount + ' directories, ' + linkCount + ' links');
		console.log('Total size: ' + Utils.formatBytes(totalSize));
	} catch (error) {
		console.error('Error:', error);
		process.exit(1);
	}
}

main();
