<script lang="ts">
	import { t } from '../../scripts/language.ts';
	import { type IPeerLishDetail } from '@shared';
	import { formatSize, formatDate } from '../../scripts/utils.ts';
	import Icon from '../../components/Icon/Icon.svelte';
	import Table from '../../components/Table/Table.svelte';
	import PeerDetailLishFileRow from './NetworkPeersPeerDetailLishFileRow.svelte';

	interface Props {
		detail: IPeerLishDetail;
		/**
		 * When set, file rows register into the surrounding navArea starting at
		 * this y so a keyboard user can scroll through them (peer detail). Leave
		 * unset where the rows would collide with another nav list on the page
		 * (LISH search peer list) — the tree renders display-only there.
		 */
		fileRowsBaseY?: number | undefined;
	}
	let { detail, fileRowsBaseY = undefined }: Props = $props();

	interface TreeNode {
		name: string;
		children: TreeNode[];
		type: 'dir' | 'file' | 'link';
		size: number;
		path: string;
	}
	interface FlatRow {
		node: TreeNode;
		depth: number;
	}

	function buildFileTree(d: IPeerLishDetail): TreeNode[] {
		const root: TreeNode = { name: '/', children: [], type: 'dir', size: 0, path: '' };
		const dirMap = new Map<string, TreeNode>();
		dirMap.set('', root);

		function ensureDir(path: string): TreeNode {
			if (dirMap.has(path)) return dirMap.get(path)!;
			const parts = path.split('/');
			const parentPath = parts.slice(0, -1).join('/');
			const parent = ensureDir(parentPath);
			const node: TreeNode = { name: parts[parts.length - 1] ?? '', children: [], type: 'dir', size: 0, path };
			parent.children.push(node);
			dirMap.set(path, node);
			return node;
		}

		for (const dir of d.directories) ensureDir(dir.path);
		for (const file of d.files) {
			const parts = file.path.split('/');
			const parentPath = parts.slice(0, -1).join('/');
			ensureDir(parentPath).children.push({ name: parts[parts.length - 1] ?? '', children: [], type: 'file', size: file.size, path: file.path });
		}
		for (const link of d.links) {
			const parts = link.path.split('/');
			const parentPath = parts.slice(0, -1).join('/');
			ensureDir(parentPath).children.push({ name: (parts[parts.length - 1] ?? '') + ' → ' + link.target, children: [], type: 'link', size: 0, path: link.path });
		}

		function sortTree(node: TreeNode): void {
			node.children.sort((a, b) => {
				if (a.type === 'dir' && b.type !== 'dir') return -1;
				if (a.type !== 'dir' && b.type === 'dir') return 1;
				return a.name.localeCompare(b.name);
			});
			for (const child of node.children) sortTree(child);
		}
		sortTree(root);
		return root.children;
	}

	function flattenTree(nodes: TreeNode[], depth: number, out: FlatRow[]): void {
		for (const node of nodes) {
			out.push({ node, depth });
			if (node.type === 'dir' && node.children.length > 0) flattenTree(node.children, depth + 1, out);
		}
	}

	let fileRows = $derived.by((): FlatRow[] => {
		const rows: FlatRow[] = [];
		flattenTree(buildFileTree(detail), 0, rows);
		return rows;
	});

	function typeIcon(type: TreeNode['type']): string {
		return type === 'dir' ? '/img/directory.svg' : type === 'link' ? '/img/link.svg' : '/img/file.svg';
	}
</script>

<style>
	.detail {
		display: flex;
		flex-direction: column;
		gap: 2vh;
		width: 100%;
	}

	.info-section {
		display: flex;
		flex-direction: column;
		gap: 1vh;
		padding: 2vh;
		background-color: var(--secondary-hard-background);
		border: 0.4vh solid var(--secondary-softer-background);
		border-radius: 2vh;
		color: var(--secondary-foreground);
		box-sizing: border-box;
	}

	.info-row {
		display: flex;
		gap: 1vh;
		flex-wrap: wrap;
	}

	.info-row .label {
		color: var(--disabled-foreground);
		font-size: 1.8vh;
		min-width: 16vh;
	}

	.info-row .value {
		color: var(--secondary-foreground);
		font-size: 1.8vh;
		word-break: break-all;
	}

	.info-row .value.mono {
		font-family: var(--font-mono);
	}

	.info-row .value.description {
		white-space: pre-wrap;
	}

	/* Mirrors the Table component frame so both render modes look the same. */
	.file-tree {
		display: flex;
		flex-direction: column;
		border: 0.2vh solid var(--secondary-softer-background);
		border-radius: 1vh;
		overflow: hidden;
		width: 100%;
		box-sizing: border-box;
		color: var(--secondary-foreground);
	}

	/* Mirrors TableRow metrics so the display-only tree looks identical to the nav-registered one. */
	.file-tree-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 2vh;
		padding: 1.5vh 2vh;
		border-bottom: 0.2vh solid var(--secondary-softer-background);
	}

	.file-tree-row:last-child {
		border-bottom: none;
	}

	.fname {
		font-size: 1.8vh;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		display: flex;
		align-items: center;
		gap: 0.5vh;
		min-width: 0;
	}

	.indent {
		display: inline-block;
		flex-shrink: 0;
	}

	.fsize {
		font-size: 1.8vh;
		white-space: nowrap;
		color: var(--disabled-foreground);
	}
</style>

<div class="detail">
	<div class="info-section">
		{#if detail.name}
			<div class="info-row"><span class="label">{$t('common.name')}:</span> <span class="value">{detail.name}</span></div>
		{/if}
		<div class="info-row"><span class="label">{$t('network.lishID')}:</span> <span class="value mono">{detail.id}</span></div>
		{#if detail.description}
			<div class="info-row"><span class="label">{$t('common.description')}:</span> <span class="value description">{detail.description}</span></div>
		{/if}
		<div class="info-row"><span class="label">{$t('network.created')}:</span> <span class="value">{formatDate(detail.created)}</span></div>
		<div class="info-row"><span class="label">{$t('network.totalSize')}:</span> <span class="value">{formatSize(detail.totalSize)}</span></div>
		<div class="info-row"><span class="label">{$t('network.chunkSize')}:</span> <span class="value">{formatSize(detail.chunkSize)}</span></div>
		<div class="info-row"><span class="label">{$t('network.checksumAlgo')}:</span> <span class="value">{detail.checksumAlgo}</span></div>
		<div class="info-row"><span class="label">{$t('common.files')}:</span> <span class="value">{detail.fileCount}</span></div>
		<div class="info-row"><span class="label">{$t('network.directories')}:</span> <span class="value">{detail.directoryCount}</span></div>
	</div>
	{#if fileRows.length > 0}
		{#if fileRowsBaseY !== undefined}
			<Table columns="1fr auto" columnsMobile="1fr auto">
				{#each fileRows as row, i (row.node.path + ':' + i)}
					<PeerDetailLishFileRow name={row.node.name} type={row.node.type} size={row.node.size} depth={row.depth} rowY={fileRowsBaseY + i} />
				{/each}
			</Table>
		{:else}
			<div class="file-tree">
				{#each fileRows as row, i (row.node.path + ':' + i)}
					<div class="file-tree-row">
						<span class="fname">
							<span class="indent" style="width: {row.depth * 2.5}vh"></span>
							<Icon img={typeIcon(row.node.type)} size="1.8vh" padding="0" colorVariable="--secondary-foreground" />
							{row.node.name}
						</span>
						<span class="fsize">{row.node.type === 'file' ? formatSize(row.node.size) : ''}</span>
					</div>
				{/each}
			</div>
		{/if}
	{/if}
</div>
