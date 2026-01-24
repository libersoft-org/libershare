<script lang="ts">
	import { onMount } from 'svelte';
	import { useArea, activateArea, activeArea } from '../../scripts/areas.ts';
	import { t } from '../../scripts/language.ts';
	import { api } from '../../scripts/api.ts';
	import Table from '../Table/Table.svelte';
	import Header from '../Table/TableHeader.svelte';
	import Cell from '../Table/TableCell.svelte';
	import StorageItem from '../Storage/StorageItem.svelte';
	import Alert from '../Alert/Alert.svelte';
	export type StorageItemType = 'folder' | 'file' | 'drive';
	export interface StorageItemData {
		id: string;
		name: string;
		path: string;
		type: StorageItemType;
		size?: string;
		modified?: string;
		hidden?: boolean;
	}
	interface FsEntry {
		name: string;
		path: string;
		type: 'file' | 'directory' | 'drive';
		size?: number;
		modified?: string;
		hidden?: boolean;
	}
	interface Props {
		areaID: string;
		initialPath?: string;
		foldersOnly?: boolean;
		showPath?: boolean;
		onBack?: () => void;
		onSelect?: (path: string) => void;
		onDownAtEnd?: () => boolean;
	}
	const columns = '1fr 8vw 12vw';
	let { areaID, initialPath = '', foldersOnly = false, showPath = true, onBack, onSelect, onDownAtEnd }: Props = $props();
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

	async function loadDirectory(path?: string, selectName?: string): Promise<void> {
		loading = true;
		error = null;
		// Set the intended path immediately so it's visible during loading
		if (path) {
			currentPath = path;
			parentPath = getParentPath(path);
		}
		try {
			const result = await api.fsList(path);
			currentPath = result.path;
			parentPath = getParentPath(result.path);
			let entries: StorageItemData[] = result.entries.map((entry: FsEntry, index: number) => ({
				id: String(index + 1),
				name: entry.name,
				path: entry.path,
				type: entry.type === 'directory' ? 'folder' : entry.type,
				size: formatSize(entry.size),
				modified: formatDate(entry.modified),
				hidden: entry.hidden,
			}));

			// Filter to folders only if requested
			if (foldersOnly) entries = entries.filter(e => e.type === 'folder' || e.type === 'drive');
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
			// Select specific item by name, or default to first
			if (selectName) {
				const idx = entries.findIndex(e => e.name === selectName);
				selectedIndex = idx >= 0 ? idx : 0;
			} else selectedIndex = 0;
		} catch (e: any) {
			error = e.message || 'Failed to load directory';
			// Even on error, provide ".." entry to navigate up if we have a parent path
			// Don't show ".." at root level (Linux "/" or empty path, Windows drive list)
			const isAtRoot = !currentPath || currentPath === separator || (separator === '/' && currentPath === '/');
			if (!isAtRoot && parentPath !== null) {
				items = [
					{
						id: '0',
						name: '..',
						path: parentPath || '',
						type: 'folder',
					},
				];
				selectedIndex = 0;
			} else items = [];
		} finally {
			loading = false;
		}
	}

	function scrollToSelected(): void {
		const element = itemElements[selectedIndex];
		if (element) element.scrollIntoView({ behavior: 'smooth', block: 'center' });
	}

	async function navigateInto(item: StorageItemData): Promise<void> {
		if (item.type === 'folder' || item.type === 'drive') {
			// If navigating to "..", select the folder we came from
			if (item.name === '..') {
				const currentName = currentPath.split(separator).filter(Boolean).pop();
				await loadDirectory(item.path, currentName);
			} else await loadDirectory(item.path);
		}
	}

	async function navigateUp(): Promise<void> {
		if (parentPath !== null) {
			// Get current directory name to select after going up
			const currentName = currentPath.split(separator).filter(Boolean).pop();
			await loadDirectory(parentPath || undefined, currentName);
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
			if (onDownAtEnd) return onDownAtEnd();
			return false;
		},
		left: () => false,
		right: () => false,
		confirmDown: () => {},
		confirmUp: () => {
			const item = items[selectedIndex];
			if (item && (item.type === 'folder' || item.type === 'drive')) navigateInto(item);
		},
		confirmCancel: () => {},
		back: () => {
			if (parentPath !== null) navigateUp();
			else onBack?.();
		},
	};

	export function getCurrentPath(): string {
		return currentPath;
	}

	export function getItemElements() {
		return itemElements;
	}

	onMount(() => {
		const unregister = useArea(areaID, areaHandlers);
		activateArea(areaID);

		(async () => {
			try {
				const info = await api.fsInfo();
				separator = info.separator;
				// Resolve initial path
				let startPath = initialPath;
				if (startPath.startsWith('~')) startPath = info.home + startPath.slice(1);
				await loadDirectory(startPath || info.home);
			} catch (e: any) {
				error = e.message || 'Failed to initialize';
				loading = false;
			}
		})();
		return unregister;
	});
</script>

<style>
	.wrapper {
		display: flex;
		flex-direction: column;
		gap: 1vh;
		height: 100%;
		overflow: hidden;
	}

	.container {
		margin: 0 2vh;
		border: 0.4vh solid var(--secondary-softer-background);
		border-radius: 2vh;
		overflow: hidden;
	}

	.path {
		padding: 1vh 1.5vh;
		font-size: 2vh;
		background: var(--secondary-background);
		border-bottom: 1px solid var(--secondary-softer-background);
		color: var(--primary-foreground);
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

<div class="wrapper">
	{#if showPath}
		<div class="path">{currentPath || '/'}</div>
	{/if}
	{#if error}
		<Alert type="error" message={error} />
	{/if}
	<div class="container">
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
					{#each items as item, index (item.id)}
						<div bind:this={itemElements[index]}>
							<StorageItem name={item.name} type={item.type} size={item.size} modified={item.modified} selected={active && selectedIndex === index} isLast={index === items.length - 1} odd={index % 2 === 0} />
						</div>
					{/each}
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
</div>
