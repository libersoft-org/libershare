// Quick heap snapshot analysis - finds top object types by instance count and total size
export {};
const path = process.argv[2];
if (!path) {
	console.error('Usage: bun analyze-heap.ts <heapsnapshot>');
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

const typeCount = new Map<string, { count: number; size: number }>();

for (let i = 0; i < nodes.length; i += nodeFieldCount) {
	const type = nodeTypes[nodes[i + typeIdx]!]!;
	const name = strings[nodes[i + nameIdx]!]!;
	const size = nodes[i + selfSizeIdx]!;
	const key = `${type}:${name}`;
	const cur = typeCount.get(key) ?? { count: 0, size: 0 };
	cur.count++;
	cur.size += size;
	typeCount.set(key, cur);
}

const top = [...typeCount.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, 40);

console.log('\nTop 40 by total bytes:');
console.log('count'.padStart(8), 'totalMB'.padStart(8), 'avgB'.padStart(7), 'type:name');
for (const [key, { count, size }] of top) {
	console.log(
		String(count).padStart(8),
		(size / 1024 / 1024).toFixed(2).padStart(8),
		Math.round(size / count)
			.toString()
			.padStart(7),
		key
	);
}

console.log('\nTop 30 by instance count:');
const topCount = [...typeCount.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 30);
for (const [key, { count, size }] of topCount) {
	console.log(
		String(count).padStart(8),
		(size / 1024 / 1024).toFixed(2).padStart(8),
		Math.round(size / count)
			.toString()
			.padStart(7),
		key
	);
}
