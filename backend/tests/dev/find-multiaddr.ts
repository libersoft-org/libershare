// Find specific suspect class instances in heap snapshot
export {};
const path = process.argv[2];
const target = process.argv[3] ?? 'Multiaddr';
if (!path) {
	console.error('Usage: bun find-multiaddr.ts <heapsnapshot> [classname]');
	process.exit(1);
}

console.log(`Reading ${path}...`);
const file = Bun.file(path);
const data = (await file.json()) as any;

const meta = data.snapshot.meta;
const nodeFields = meta.node_fields as string[];
const nodeTypes = meta.node_types[0] as string[];
const nodeFieldCount = nodeFields.length;
const nameIdx = nodeFields.indexOf('name');
const typeIdx = nodeFields.indexOf('type');
const selfSizeIdx = nodeFields.indexOf('self_size');

const nodes = data.nodes as number[];
const strings = data.strings as string[];

console.log(`Searching for "${target}" in ${nodes.length / nodeFieldCount} nodes...`);

const matches = new Map<string, { count: number; size: number }>();

for (let i = 0; i < nodes.length; i += nodeFieldCount) {
	const type = nodeTypes[nodes[i + typeIdx]!]!;
	const name = strings[nodes[i + nameIdx]!]!;
	const size = nodes[i + selfSizeIdx]!;

	if (name.toLowerCase().includes(target.toLowerCase())) {
		const key = `${type}:${name}`;
		const cur = matches.get(key) ?? { count: 0, size: 0 };
		cur.count++;
		cur.size += size;
		matches.set(key, cur);
	}
}

const top = [...matches.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 50);
console.log(`\nMatches for "${target}":`);
console.log('count'.padStart(8), 'totalKB'.padStart(8), 'avgB'.padStart(7), 'type:name');
for (const [key, { count, size }] of top) {
	console.log(
		String(count).padStart(8),
		(size / 1024).toFixed(1).padStart(8),
		Math.round(size / count)
			.toString()
			.padStart(7),
		key
	);
}
