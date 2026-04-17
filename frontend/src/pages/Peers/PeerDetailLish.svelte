<script lang="ts">
	import { onMount } from 'svelte';
	import { t, translateError } from '../../scripts/language.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import { addNotification } from '../../scripts/notifications.ts';
	import { type PeerLishEntry, type IPeerLishDetail } from '@shared';
	import { api } from '../../scripts/api.ts';
	import { formatSize } from '../../scripts/utils.ts';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import Alert from '../../components/Alert/Alert.svelte';
	import Spinner from '../../components/Spinner/Spinner.svelte';
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

	interface TreeNode {
		name: string;
		children: TreeNode[];
		type: 'dir' | 'file' | 'link';
		size: number;
		path: string;
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
		gap: 2vh;
		width: 1200px;
		max-width: 100%;
	}

	.info-section {
		display: flex;
		flex-direction: column;
		gap: 1vh;
		padding: 2vh;
		background-color: var(--secondary-soft-background);
		border: 0.2vh solid var(--secondary-softer-background);
		border-radius: 1vh;
	}

	.info-row {
		display: flex;
		gap: 1vh;
	}

	.info-row .label {
		color: var(--disabled-foreground);
		font-size: 1.8vh;
		min-width: 16vh;
	}

	.info-row .value {
		color: var(--primary-foreground);
		font-size: 1.8vh;
		word-break: break-all;
	}

	.info-row .value.mono {
		font-family: var(--font-mono);
	}

	.file-tree {
		padding: 2vh;
		background-color: var(--secondary-soft-background);
		border: 0.2vh solid var(--secondary-softer-background);
		border-radius: 1vh;
		font-family: var(--font-mono);
		font-size: 1.6vh;
		line-height: 2.2;
		overflow-x: auto;
	}

	.tree-item {
		white-space: nowrap;
	}

	.tree-icon {
		display: inline-block;
		width: 2.5vh;
		text-align: center;
		margin-right: 0.5vh;
	}

	.tree-size {
		color: var(--disabled-foreground);
		margin-left: 1vh;
	}

	.description {
		white-space: pre-wrap;
	}

	.section-title {
		font-size: 2.2vh;
		font-weight: bold;
		color: var(--primary-foreground);
	}
</style>

<div class="peer-lish-detail">
	<div class="container">
		<ButtonBar>
			<Button icon="/img/back.svg" label={$t('common.back')} position={[0, 0]} onConfirm={onBack} width="auto" />
			{#if detail}
				<Button icon="/img/download.svg" label={$t('peers.addToDownloads')} position={[1, 0]} onConfirm={addToDownloads} width="auto" disabled={adding} />
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
						<span class="label">{$t('peers.lishName')}:</span>
						<span class="value">{detail.name}</span>
					</div>
				{/if}
				<div class="info-row">
					<span class="label">{$t('peers.lishID')}:</span>
					<span class="value mono">{detail.id}</span>
				</div>
				{#if detail.description}
					<div class="info-row">
						<span class="label">{$t('peers.description')}:</span>
						<span class="value description">{detail.description}</span>
					</div>
				{/if}
				<div class="info-row">
					<span class="label">{$t('peers.totalSize')}:</span>
					<span class="value">{formatSize(detail.totalSize)}</span>
				</div>
				<div class="info-row">
					<span class="label">{$t('peers.files')}:</span>
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
			<div class="section-title">{$t('peers.fileStructure')}</div>
			<div class="file-tree">
				{#each buildFileTree(detail) as node}
					{@render treeNode(node, 0)}
				{/each}
			</div>
		{/if}
	</div>
</div>
{#snippet treeNode(node: TreeNode, depth: number)}
	<div class="tree-item" style="padding-left: {depth * 2.5}vh">
		{#if node.type === 'dir'}
			<span class="tree-icon">📁</span>{node.name}
			{#each node.children as child}
				{@render treeNode(child, depth + 1)}
			{/each}
		{:else if node.type === 'link'}
			<span class="tree-icon">🔗</span>{node.name}
		{:else}
			<span class="tree-icon">📄</span>{node.name}<span class="tree-size">{formatSize(node.size)}</span>
		{/if}
	</div>
{/snippet}
