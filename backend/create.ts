import { Utils } from './utils.ts';
interface IManifest {
	version: number;
	created: string;
	filename: string;
	totalSize: number;
	chunkSize: number;
	checksumAlgo: HashAlgorithm;
	checksums: string[];
}
interface IArgs {
	input?: string;
	chunksize?: number;
	output?: string;
	algo?: string;
}
const SUPPORTED_ALGOS = ['sha256', 'sha512', 'blake2b256', 'blake2b512', 'blake2s256', 'shake128', 'shake256'] as const;
type HashAlgorithm = (typeof SUPPORTED_ALGOS)[number];
const MANIFEST_VERSION = 1;
const DEFAULT_CHUNK_SIZE = 5242880; // 5 MB
const DEFAULT_OUTPUT = 'output.lish';
const DEFAULT_ALGO: HashAlgorithm = 'sha256';

function parseArgs(args: string[]): IArgs {
	const parsed: IArgs = {};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === '--input' && i + 1 < args.length) parsed.input = args[++i];
		else if (arg === '--chunksize' && i + 1 < args.length) parsed.chunksize = parseInt(args[++i], 10);
		else if (arg === '--output' && i + 1 < args.length) parsed.output = args[++i];
		else if (arg === '--algo' && i + 1 < args.length) parsed.algo = args[++i];
	}
	return parsed;
}

async function calculateChecksum(file: ReturnType<typeof Bun.file>, offset: number, chunkSize: number, algo: HashAlgorithm): Promise<string> {
	const end = Math.min(offset + chunkSize, file.size);
	const chunk = file.slice(offset, end);
	const buffer = await chunk.arrayBuffer();
	// Calculate checksum using Bun API with specified algorithm
	const hasher = new Bun.CryptoHasher(algo as any);
	hasher.update(buffer);
	return hasher.digest('hex');
}

async function createManifest(filePath: string, chunkSize: number, algo: HashAlgorithm): Promise<IManifest> {
	const file = Bun.file(filePath);
	const totalSize = file.size;
	const totalChunks = Math.ceil(totalSize / chunkSize);
	const checksums: string[] = [];
	let chunkIndex = 0;
	for (let offset = 0; offset < totalSize; offset += chunkSize) {
		chunkIndex++;
		const checksum = await calculateChecksum(file, offset, chunkSize, algo);
		checksums.push(checksum);
		process.stdout.write('\rProcessing chunks: ' + chunkIndex + '/' + totalChunks);
	}
	process.stdout.write('\n');
	const filename = filePath.split(/[\\/]/).pop() || filePath;
	const created = new Date().toISOString();
	return {
		version: MANIFEST_VERSION,
		created,
		filename,
		totalSize,
		chunkSize,
		checksumAlgo: algo,
		checksums,
	};
}

async function main() {
	const args = parseArgs(Bun.argv.slice(2));
	if (!args.input) {
		console.error('Error: --input parameter is required');
		console.error('Usage: bun create.ts --input <file-path> [--chunksize <bytes>] [--output <output-file>] [--algo <algorithm>]');
		console.error('Supported algorithms: ' + SUPPORTED_ALGOS.join(', '));
		console.error('Example: bun create.ts --input myfile.bin --chunksize 10485760 --output ' + DEFAULT_OUTPUT + ' --algo ' + DEFAULT_ALGO);
		process.exit(1);
	}
	const inputFile = args.input;
	const chunkSize = args.chunksize || DEFAULT_CHUNK_SIZE;
	const outputFile = args.output || DEFAULT_OUTPUT;
	const algo = (args.algo || DEFAULT_ALGO) as HashAlgorithm;
	if (!SUPPORTED_ALGOS.includes(algo as any)) {
		console.error('Error: Unsupported algorithm "' + algo + '"');
		console.error('Supported algorithms: ' + SUPPORTED_ALGOS.join(', '));
		process.exit(1);
	}
	try {
		const file = Bun.file(inputFile);
		const fileSize = file.size;
		console.log('Processing file: ' + inputFile);
		console.log('File size: ' + Utils.formatBytes(fileSize));
		console.log('Chunk size: ' + Utils.formatBytes(chunkSize));
		console.log('Algorithm: ' + algo);
		const manifest = await createManifest(inputFile, chunkSize, algo);
		await Bun.write(outputFile, JSON.stringify(manifest, null, 2));
		console.log('LISH file saved to: ' + outputFile);
	} catch (error) {
		console.error('Error:', error);
		process.exit(1);
	}
}

main();
