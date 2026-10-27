<script lang="ts">
	import { t, translateError } from '../../scripts/language.ts';
	import { type IPeerLishDetail } from '@shared';
	import { formatSize, formatDateTime } from '../../scripts/utils.ts';
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
		/** Reads the chunk checksums of a file on request; without it the file details leave them out. */
		loadChecksums?: ((path: string) => Promise<string[]>) | undefined;
	}
	let { detail, fileRowsBaseY = undefined, loadChecksums }: Props = $props();

	interface TreeNode {
		name: string;
		children: TreeNode[];
		type: 'dir' | 'file' | 'link';
		size: number;
		path: string;
		/** What the manifest says about the entry; absent for a folder only implied by the paths in it. */
		entry?: { permissions?: string | undefined; modified?: string | undefined; created?: string | undefined; target?: string; hardlink?: boolean | undefined } | undefined;
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

		for (const dir of d.directories) ensureDir(dir.path).entry = dir;
		for (const file of d.files) {
			const parts = file.path.split('/');
			const parentPath = parts.slice(0, -1).join('/');
			ensureDir(parentPath).children.push({ name: parts[parts.length - 1] ?? '', children: [], type: 'file', size: file.size, path: file.path, entry: file });
		}
		for (const link of d.links) {
			const parts = link.path.split('/');
			const parentPath = parts.slice(0, -1).join('/');
			ensureDir(parentPath).children.push({ name: (parts[parts.length - 1] ?? '') + ' → ' + link.target, children: [], type: 'link', size: 0, path: link.path, entry: link });
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

	// One entry at a time shows its details; its checksums are read only then, and only for a file.
	let expanded = $state<string | null>(null);
	let checksums = $state<{ key: string; list?: string[]; error?: string } | null>(null);

	function nodeKey(node: TreeNode): string {
		return node.type + ':' + node.path;
	}

	async function toggleDetails(node: TreeNode): Promise<void> {
		const key = nodeKey(node);
		expanded = expanded === key ? null : key;
		checksums = null;
		if (expanded !== key || node.type !== 'file' || !loadChecksums) return;
		checksums = { key };
		try {
			const list = await loadChecksums(node.path);
			if (checksums?.key === key) checksums = { key, list };
		} catch (e) {
			if (checksums?.key === key) checksums = { key, error: translateError(e) };
		}
	}

	// One text node rather than a row each: a large file has tens of thousands of chunks.
	function checksumText(list: string[]): string {
		return list.map((checksum, i) => `${i + 1}\t${checksum}`).join('\n');
	}

	function typeLabel(node: TreeNode): string {
		if (node.type === 'dir') return $t('lish.entryDirectory');
		if (node.type === 'file') return $t('lish.entryFile');
		return node.entry?.hardlink ? $t('lish.entryHardLink') : $t('lish.entrySymbolicLink');
	}

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

	.entry-details {
		display: flex;
		flex-direction: column;
		gap: 0.5vh;
		padding: 1vh 0 0 2.5vh;
		font-size: 1.6vh;
	}

	.entry-row {
		display: flex;
		gap: 1vh;
		min-width: 0;
	}

	.entry-row .label {
		opacity: 0.7;
		min-width: 16vh;
		flex-shrink: 0;
	}

	.entry-row .value {
		word-break: break-all;
		white-space: normal;
	}

	.mono {
		font-family: var(--font-mono);
	}

	.checksums {
		max-height: 30vh;
		overflow-y: auto;
		white-space: pre;
		font-family: var(--font-mono);
		font-size: 1.5vh;
	}

	.hint {
		font-size: 1.6vh;
		color: var(--disabled-foreground);
	}

	.fsize {
		font-size: 1.8vh;
		white-space: nowrap;
		color: var(--disabled-foreground);
	}
</style>

{#snippet entryDetails(node: TreeNode)}
	<div class="entry-details">
		<div class="entry-row"><span class="label">{$t('lish.entryType')}:</span> <span class="value">{typeLabel(node)}</span></div>
		<div class="entry-row"><span class="label">{$t('lish.entryPath')}:</span> <span class="value mono">{node.path}</span></div>
		{#if node.entry?.target !== undefined}
			<div class="entry-row"><span class="label">{$t('lish.entryTarget')}:</span> <span class="value mono">{node.entry.target}</span></div>
		{/if}
		{#if node.entry?.permissions}
			<div class="entry-row"><span class="label">{$t('lish.entryPermissions')}:</span> <span class="value mono">{node.entry.permissions}</span></div>
		{/if}
		{#if node.entry?.created}
			<div class="entry-row"><span class="label">{$t('network.created')}:</span> <span class="value">{formatDateTime(node.entry.created)}</span></div>
		{/if}
		{#if node.entry?.modified}
			<div class="entry-row"><span class="label">{$t('localStorage.modified')}:</span> <span class="value">{formatDateTime(node.entry.modified)}</span></div>
		{/if}
		{#if node.type === 'file'}
			<div class="entry-row"><span class="label">{$t('downloads.chunks')}:</span> <span class="value">{node.size === 0 ? 0 : Math.ceil(node.size / detail.chunkSize)}</span></div>
			{#if checksums?.key === nodeKey(node)}
				<div class="entry-row"><span class="label">{$t('lish.entryChecksums')}:</span></div>
				{#if checksums.list}
					<div class="checksums">{checksumText(checksums.list)}</div>
				{:else if checksums.error}
					<div class="entry-row"><span class="value">{checksums.error}</span></div>
				{:else}
					<div class="entry-row"><span class="value">{$t('lish.entryChecksumsLoading')}</span></div>
				{/if}
			{/if}
		{/if}
	</div>
{/snippet}

<div class="detail">
	<div class="info-section">
		{#if detail.name}
			<div class="info-row"><span class="label">{$t('common.name')}:</span> <span class="value">{detail.name}</span></div>
		{/if}
		<div class="info-row"><span class="label">{$t('network.lishID')}:</span> <span class="value mono">{detail.id}</span></div>
		{#if detail.description}
			<div class="info-row"><span class="label">{$t('common.description')}:</span> <span class="value description">{detail.description}</span></div>
		{/if}
		<div class="info-row"><span class="label">{$t('network.created')}:</span> <span class="value">{formatDateTime(detail.created)}</span></div>
		<div class="info-row"><span class="label">{$t('network.totalSize')}:</span> <span class="value">{formatSize(detail.totalSize)}</span></div>
		<div class="info-row"><span class="label">{$t('network.chunkSize')}:</span> <span class="value">{formatSize(detail.chunkSize)}</span></div>
		<div class="info-row"><span class="label">{$t('downloads.chunks')}:</span> <span class="value">{detail.totalChunks}</span></div>
		<div class="info-row"><span class="label">{$t('network.checksumAlgo')}:</span> <span class="value">{detail.checksumAlgo}</span></div>
		<div class="info-row"><span class="label">{$t('common.files')}:</span> <span class="value">{detail.fileCount}</span></div>
		<div class="info-row"><span class="label">{$t('network.directories')}:</span> <span class="value">{detail.directoryCount}</span></div>
	</div>
	{#if fileRows.length > 0}
		{#if fileRowsBaseY !== undefined}
			<div class="hint">{$t('lish.entryDetailsHint')}</div>
			<Table columns="1fr auto" columnsMobile="1fr auto">
				{#each fileRows as row, i (row.node.path + ':' + i)}
					<PeerDetailLishFileRow name={row.node.name} type={row.node.type} size={row.node.size} depth={row.depth} rowY={fileRowsBaseY + i} onConfirm={() => void toggleDetails(row.node)}>
						{#if expanded === nodeKey(row.node)}
							{@render entryDetails(row.node)}
						{/if}
					</PeerDetailLishFileRow>
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
