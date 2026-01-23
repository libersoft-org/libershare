<script lang="ts">
	import { onMount } from 'svelte';
	import { useArea, activateArea, activeArea } from '../../scripts/areas.ts';
	import { t } from '../../scripts/language.ts';
	import { api } from '../../scripts/api.ts';
	import Table from '../Table/Table.svelte';
	import Header from '../Table/TableHeader.svelte';
	import Cell from '../Table/TableCell.svelte';
	import StorageItem from './StorageItem.svelte';
	import Alert from '../Alert/Alert.svelte';
	import type { StorageItemData } from './types.ts';

	interface Props {
		areaID: string;
		title?: string;
		onBack?: () => void;
	}

	const columns = '1fr 8vw 12vw';
	let { areaID, title = 'Storage', onBack }: Props = $props();
	let active = $derived($activeArea === areaID);
	let selectedIndex = $state(0);
	let itemElements: HTMLElement[] = $state([]);

	let currentPath = $state<string>('');
	let parentPath = $state<string | null>(null);
	let items = $state<StorageItemData[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let separator = $state('/');

	function formatSize(bytes?: number): string {
		if (bytes === undefined) return '—';
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
		return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
	}

	function formatDate(isoDate?: string): string {
		if (!isoDate) return '—';
		return new Date(isoDate).toLocaleDateString();
	}

	function getParentPath(path: string): string | null {
		if (!path || path === separator) return null;
		if (/^[A-Z]:\\?$/i.test(path)) return '';
		const parts = path.split(separator).filter(Boolean);
		if (parts.length <= 1) {
			if (separator === '\\' && /^[A-Z]:/i.test(path)) return parts[0] + '\\';
			return separator === '/' ? '/' : '';
		}
		const parent = parts.slice(0, -1).join(separator);
		return separator === '/' ? '/' + parent : parent;
	}

	async function loadDirectory(path?: string): Promise<void> {
		loading = true;
		error = null;
		try {
			const result = await api.fsList(path);
			currentPath = result.path;
			parentPath = getParentPath(result.path);

			const entries: StorageItemData[] = result.entries.map((entry, index) => ({
				id: String(index + 1),
				name: entry.name,
				path: entry.path,
				type: entry.type === 'directory' ? 'folder' : entry.type,
				size: formatSize(entry.size),
				modified: formatDate(entry.modified),
				hidden: entry.hidden,
			}));

			// Add ".." entry if we have a parent
			if (parentPath !== null) {
				entries.unshift({
					id: '0',
					name: '..',
					path: parentPath || '',
					type: 'folder',
				});
			}

			items = entries;
			console.log('items:', items.map(i => i.name));
			selectedIndex = 0;
		} catch (e: any) {
			error = e.message || 'Failed to load directory';
			items = [];
		} finally {
			loading = false;
		}
	}

	function scrollToSelected(): void {
		const element = itemElements[selectedIndex];
		if (element) {
			element.scrollIntoView({ behavior: 'smooth', block: 'center' });
		}
	}

	async function navigateInto(item: StorageItemData): Promise<void> {
		if (item.type === 'folder' || item.type === 'drive') {
			await loadDirectory(item.path);
		}
	}

	async function navigateUp(): Promise<void> {
		if (parentPath !== null) {
			await loadDirectory(parentPath || undefined);
		}
	}

	const areaHandlers = {
		up: () => {
			if (selectedIndex > 0) {
				selectedIndex--;
				scrollToSelected();
				return true;
			}
			return false;
		},
		down: () => {
			if (selectedIndex < items.length - 1) {
				selectedIndex++;
				scrollToSelected();
				return true;
			}
			return false;
		},
		left: () => false,
		right: () => false,
		confirmDown: () => {},
		confirmUp: () => {
			const item = items[selectedIndex];
			if (item && (item.type === 'folder' || item.type === 'drive')) {
				navigateInto(item);
			}
		},
		confirmCancel: () => {},
		back: () => {
			if (parentPath !== null) {
				navigateUp();
			} else {
				onBack?.();
			}
		},
	};

	onMount(async () => {
		const unregister = useArea(areaID, areaHandlers);
		activateArea(areaID);

		try {
			const info = await api.fsInfo();
			separator = info.separator;
			await loadDirectory(info.home);
		} catch (e: any) {
			error = e.message || 'Failed to initialize';
			loading = false;
		}

		return unregister;
	});
</script>

<style>
	.container {
		display: flex;
		flex-direction: column;
		height: 100%;
	}

	.path {
		padding: 1vh 1.5vh;
		font-size: 1.6vh;
		font-family: monospace;
		background: rgba(255, 255, 255, 0.05);
		border-bottom: 1px solid rgba(255, 255, 255, 0.1);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		flex-shrink: 0;
	}

	.items {
		flex: 1;
		overflow-y: auto;
		font-size: 1.4vh;
	}
</style>

<div class="container">
<div class="path">{currentPath || '/'}</div>
<Table {columns} noBorder>
	<Header>
		<Cell>{$t.localStorage?.name}</Cell>
		<Cell align="right" desktopOnly>{$t.localStorage?.size}</Cell>
		<Cell align="right" desktopOnly>{$t.localStorage?.modified}</Cell>
	</Header>
	<div class="items">
		{#if loading}
			<Alert type="info" message="Loading..." />
		{:else if error}
			<Alert type="error" message={error} />
		{:else if items.length === 0}
			<Alert type="info" message="Empty directory" />
		{:else}
			{#each items as item, index (item.id)}
				<div bind:this={itemElements[index]}>
					<StorageItem name={item.name} type={item.type} size={item.size} modified={item.modified} selected={active && selectedIndex === index} isLast={index === items.length - 1} odd={index % 2 === 0} />
				</div>
			{/each}
		{/if}
	</div>
</Table>
</div>
