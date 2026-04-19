<script lang="ts">
	import { onMount } from 'svelte';
	import { t, translateError } from '../../scripts/language.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import { addNotification } from '../../scripts/notifications.ts';
	import { copyToClipboard } from '../../scripts/clipboard.ts';
	import { type PeerLishEntry, type IPeerLishDetail } from '@shared';
	import { api } from '../../scripts/api.ts';
	import { formatSize } from '../../scripts/utils.ts';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import Alert from '../../components/Alert/Alert.svelte';
	import Spinner from '../../components/Spinner/Spinner.svelte';
	import Table from '../../components/Table/Table.svelte';
	import PeerDetailLishFileRow from './PeerDetailLishFileRow.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		lish: PeerLishEntry;
		peerID: string;
		networkID: string;
		onBack?: (() => void) | undefined;
	}
	let { areaID, position = LAYOUT.content, lish, peerID, networkID, onBack }: Props = $props();
	let detail = $state<IPeerLishDetail | null>(null);
	let loading = $state(true);
	let error = $state('');
	let adding = $state(false);

	async function loadDetail(): Promise<void> {
		loading = true;
		error = '';
		try {
			detail = await api.lishnets.getPeerLish(lish.id, peerID, networkID);
		} catch (e: any) {
			error = translateError(e);
			detail = null;
		}
		loading = false;
	}

	async function addToDownloads(): Promise<void> {
		adding = true;
		try {
			await api.lishnets.addPeerLish(lish.id, peerID, networkID);
			addNotification($t('peers.lishAdded', { name: lish.name || lish.id }), 'success');
		} catch (e: any) {
			addNotification(translateError(e), 'error');
		}
		adding = false;
	}

	async function copyLishID(): Promise<void> {
		await copyToClipboard(lish.id, $t('common.lishIDCopied'));
	}

	function buildFileTree(detail: IPeerLishDetail): TreeNode[] {
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

		for (const dir of detail.directories) {
			ensureDir(dir.path);
		}

		for (const file of detail.files) {
			const parts = file.path.split('/');
			const parentPath = parts.slice(0, -1).join('/');
			const parent = ensureDir(parentPath);
			parent.children.push({ name: parts[parts.length - 1] ?? '', children: [], type: 'file', size: file.size, path: file.path });
		}

		for (const link of detail.links) {
			const parts = link.path.split('/');
			const parentPath = parts.slice(0, -1).join('/');
			const parent = ensureDir(parentPath);
			parent.children.push({ name: (parts[parts.length - 1] ?? '') + ' → ' + link.target, children: [], type: 'link', size: 0, path: link.path });
		}

		// Sort: directories first, then files, alphabetically
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
		if (!detail) return [];
		const tree = buildFileTree(detail);
		const rows: FlatRow[] = [];
		flattenTree(tree, 0, rows);
		return rows;
	});

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

	createNavArea(() => ({ areaID, position, onBack, activate: true }));

	onMount(() => {
		loadDetail();
	});
</script>

<style>
	.peer-lish-detail {
		display: flex;
		flex-direction: column;
		align-items: center;
		flex: 1;
		min-height: 0;
		padding: 2vh;
		gap: 2vh;
		overflow-y: auto;
	}

	.container {
		display: flex;
		flex-direction: column;
		align-items: stretch;
		gap: 2vh;
		width: 1200px;
		max-width: calc(94vw);
		padding: 2vh;
		border-radius: 2vh;
		box-sizing: border-box;
		background-color: var(--secondary-background);
		box-shadow: 0 0 2vh var(--secondary-background);
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

	.description {
		white-space: pre-wrap;
	}

	@media (max-width: 1199px) {
		.container {
			max-width: calc(100vw);
			margin: 0;
			border-radius: 0;
			box-shadow: none;
		}
	}
</style>

<div class="peer-lish-detail">
	<div class="container">
		<ButtonBar>
			<Button icon="/img/back.svg" label={$t('common.back')} position={[0, 0]} onConfirm={onBack} width="auto" />
			{#if detail}
				<Button icon="/img/download.svg" label={$t('peers.addToDownloads')} position={[1, 0]} onConfirm={addToDownloads} width="auto" disabled={adding} />
				<Button icon="/img/copy.svg" label={$t('common.copyLishID')} position={[2, 0]} onConfirm={copyLishID} width="auto" />
			{/if}
		</ButtonBar>
		{#if loading}
			<Spinner size="8vh" />
		{:else if error}
			<Alert type="error" message={error} />
		{:else if detail}
			<div class="info-section">
				{#if detail.name}
					<div class="info-row">
						<span class="label">{$t('common.name')}:</span>
						<span class="value">{detail.name}</span>
					</div>
				{/if}
				<div class="info-row">
					<span class="label">{$t('peers.lishID')}:</span>
					<span class="value mono">{detail.id}</span>
				</div>
				{#if detail.description}
					<div class="info-row">
						<span class="label">{$t('common.description')}:</span>
						<span class="value description">{detail.description}</span>
					</div>
				{/if}
				<div class="info-row">
					<span class="label">{$t('peers.totalSize')}:</span>
					<span class="value">{formatSize(detail.totalSize)}</span>
				</div>
				<div class="info-row">
					<span class="label">{$t('common.files')}:</span>
					<span class="value">{detail.fileCount}</span>
				</div>
				<div class="info-row">
					<span class="label">{$t('peers.directories')}:</span>
					<span class="value">{detail.directoryCount}</span>
				</div>
				<div class="info-row">
					<span class="label">{$t('peers.created')}:</span>
					<span class="value">{new Date(detail.created).toLocaleString()}</span>
				</div>
				<div class="info-row">
					<span class="label">{$t('peers.chunkSize')}:</span>
					<span class="value">{formatSize(detail.chunkSize)}</span>
				</div>
				<div class="info-row">
					<span class="label">{$t('peers.checksumAlgo')}:</span>
					<span class="value">{detail.checksumAlgo}</span>
				</div>
			</div>
			<Table columns="1fr auto" columnsMobile="1fr auto">
				{#each fileRows as row, i (row.node.path + ':' + i)}
					<PeerDetailLishFileRow name={row.node.name} type={row.node.type} size={row.node.size} depth={row.depth} rowY={i + 1} />
				{/each}
			</Table>
		{/if}
	</div>
</div>
