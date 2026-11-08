<script lang="ts">
	import { t } from '../../scripts/language.ts';
	import { type IPeerLishDetail, isISODate } from '@shared';
	import { formatSize, formatDateTime } from '../../scripts/utils.ts';
	import Table from '../../components/Table/Table.svelte';
	import TableRow from '../../components/Table/TableRow.svelte';
	import TableCell from '../../components/Table/TableCell.svelte';
	import PeerDetailLishFileRow from './NetworkPeersPeerDetailLishFileRow.svelte';

	interface Props {
		detail: IPeerLishDetail;
		/**
		 * When set, file rows register into the surrounding navArea starting at
		 * this y so a keyboard user can scroll through them and open their details.
		 * Leave unset where the rows would collide with another nav list on the page
		 * (LISH search peer list) — the rows then open by mouse only.
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
		/** What the manifest says about the entry; absent for a folder only implied by the paths in it. */
		entry?: { permissions?: string | undefined; modified?: string | undefined; created?: string | undefined; target?: string; hardlink?: boolean | undefined; invalidFields?: string[] | undefined } | undefined;
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

	// One entry at a time shows its details.
	let expanded = $state<string | null>(null);

	function nodeKey(node: TreeNode): string {
		return node.type + ':' + node.path;
	}

	function toggleDetails(node: TreeNode): void {
		const key = nodeKey(node);
		expanded = expanded === key ? null : key;
	}

	/** Undefined for a link whose `hardlink` flag was invalid. */
	function typeLabel(node: TreeNode): string | undefined {
		if (node.type === 'dir') return $t('lish.entryDirectory');
		if (node.type === 'file') return $t('lish.entryFile');
		if (isInvalid(node, 'hardlink')) return undefined;
		return node.entry?.hardlink === true ? $t('lish.entryHardLink') : $t('lish.entrySymbolicLink');
	}

	function isInvalid(node: TreeNode, field: string): boolean {
		return node.entry?.invalidFields?.includes(field) ?? false;
	}

	/**
	 * A manifest field as text, or undefined when it does not hold what the field should. The values
	 * come from a file anyone can write, so nothing else reaches the date formatter.
	 */
	function fieldText(value: unknown, kind: 'text' | 'date'): string | undefined {
		if (typeof value !== 'string') return undefined;
		if (kind === 'text') return value;
		return isISODate(value) ? formatDateTime(value) : undefined;
	}

	let created = $derived(fieldText(detail.created, 'date'));
</script>

<style>
	.detail {
		display: flex;
		flex-direction: column;
		gap: 2vh;
		width: 100%;
	}

	.info-section {
		background-color: var(--secondary-hard-background);
		border: 0.4vh solid var(--secondary-softer-background);
		border-radius: 2vh;
		overflow: hidden;
	}

	/* Wrap by words, breaking only a word wider than the cell, instead of the cell's break-all. */
	.info-section .label,
	.info-section .value {
		font-size: 1.8vh;
		word-break: normal;
		overflow-wrap: anywhere;
	}

	.info-section .value.description {
		white-space: pre-wrap;
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

	.invalid {
		color: var(--color-error);
	}

	.hint {
		font-size: 1.6vh;
		color: var(--disabled-foreground);
	}
</style>

{#snippet metaRow(label: string, value: unknown, invalid: boolean, kind: 'text' | 'date')}
	{#if (value !== undefined && value !== '') || invalid}
		{@const text = fieldText(value, kind)}
		<div class="entry-row"><span class="label">{label}:</span> <span class="value" class:mono={kind === 'text'} class:invalid={text === undefined}>{text ?? $t('lish.entryInvalidValue')}</span></div>
	{/if}
{/snippet}

{#snippet infoRow(label: string, value: string | number, kind: 'text' | 'mono' | 'description' = 'text', invalid = false)}
	<TableRow>
		<TableCell align="right" wrap><span class="label">{label}:</span></TableCell>
		<TableCell wrap><span class="value" class:mono={kind === 'mono'} class:description={kind === 'description'} class:invalid>{value}</span></TableCell>
	</TableRow>
{/snippet}

{#snippet entryDetailsView(node: TreeNode)}
	<div class="entry-details">
		<div class="entry-row"><span class="label">{$t('lish.entryType')}:</span> <span class="value" class:invalid={typeLabel(node) === undefined}>{typeLabel(node) ?? $t('lish.entryInvalidValue')}</span></div>
		<div class="entry-row"><span class="label">{$t('lish.entryPath')}:</span> <span class="value mono">{node.path}</span></div>
		{#if node.entry?.target !== undefined}
			<div class="entry-row"><span class="label">{$t('lish.entryTarget')}:</span> <span class="value mono">{node.entry.target}</span></div>
		{/if}
		{@render metaRow($t('lish.entryPermissions'), node.entry?.permissions, isInvalid(node, 'permissions'), 'text')}
		{@render metaRow($t('network.created'), node.entry?.created, isInvalid(node, 'created'), 'date')}
		{@render metaRow($t('localStorage.modified'), node.entry?.modified, isInvalid(node, 'modified'), 'date')}
		{#if node.type === 'file'}
			<div class="entry-row"><span class="label">{$t('downloads.chunks')}:</span> <span class="value">{node.size === 0 ? 0 : Math.ceil(node.size / detail.chunkSize)}</span></div>
		{/if}
	</div>
{/snippet}

<div class="detail">
	<div class="info-section">
		<!-- Each row is its own grid, so the label column has a set width rather than the widest label; it shrinks on a narrow screen and the labels wrap. -->
		<Table columns="minmax(0, min(32vh, 40%)) minmax(0, 1fr)" columnsMobile="minmax(0, min(32vh, 40%)) minmax(0, 1fr)" noBorder compact>
			{@render infoRow($t('network.lishID'), detail.id, 'mono')}
			{#if detail.name}
				{@render infoRow($t('common.name'), detail.name)}
			{/if}
			{#if detail.description}
				{@render infoRow($t('common.description'), detail.description, 'description')}
			{/if}
			{@render infoRow($t('network.created'), created ?? $t('lish.entryInvalidValue'), 'text', created === undefined)}
			{@render infoRow($t('network.totalSize'), formatSize(detail.totalSize))}
			{@render infoRow($t('network.chunkSize'), formatSize(detail.chunkSize))}
			{@render infoRow($t('downloads.chunks'), detail.totalChunks)}
			{@render infoRow($t('network.checksumAlgo'), detail.checksumAlgo)}
			{@render infoRow($t('common.files'), detail.fileCount)}
			{@render infoRow($t('network.directories'), detail.directoryCount)}
		</Table>
	</div>
	{#if fileRows.length > 0}
		<div class="hint">{$t('lish.entryDetailsHint')}</div>
		<Table columns="1fr auto" columnsMobile="1fr auto">
			{#each fileRows as row, i (row.node.path + ':' + i)}
				<PeerDetailLishFileRow name={row.node.name} type={row.node.type} size={row.node.size} depth={row.depth} rowY={fileRowsBaseY === undefined ? undefined : fileRowsBaseY + i} onConfirm={() => toggleDetails(row.node)} expanded={expanded === nodeKey(row.node)}>
					{@render entryDetailsView(row.node)}
				</PeerDetailLishFileRow>
			{/each}
		</Table>
	{/if}
</div>
