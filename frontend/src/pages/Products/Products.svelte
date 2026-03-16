<script lang="ts">
	import { onMount } from 'svelte';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { CONTENT_OFFSETS } from '../../scripts/navigationLayout.ts';
	import { createNavArea, navItem, type NavPos } from '../../scripts/navArea.svelte.ts';
	import SearchBar from '../../components/Search/SearchBar.svelte';
	import ProductsList from './ProductsList.svelte';
	import { listCatalogEntries, searchCatalog, subscribeCatalogEvents, type CatalogEntryResponse } from '../../scripts/catalog.ts';
	import { api } from '../../scripts/api.ts';
	interface Props {
		areaID: string;
		position: Position;
		title?: string;
		category?: string;
		networkID?: string;
		onBack?: () => void;
	}
	let { areaID, position, title = 'Library', networkID, onBack }: Props = $props();
	let activeNetworkID = $state(networkID ?? '');
	let networkName = $state('');
	let searchAreaID = $derived(`${areaID}-search`);
	let listAreaID = $derived(`${areaID}-list`);
	let searchPosition = $derived({ x: position.x + CONTENT_OFFSETS.top.x, y: position.y + CONTENT_OFFSETS.top.y });
	let listPosition = $derived({ x: position.x + CONTENT_OFFSETS.main.x, y: position.y + CONTENT_OFFSETS.main.y });

	let entries = $state<CatalogEntryResponse[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let searchQuery = $state('');

	let items = $derived(entries.map(e => ({
		id: e.lish_id,
		title: e.name || e.lish_id,
		description: e.description,
		totalSize: e.total_size,
		fileCount: e.file_count,
		tags: e.tags,
		contentType: e.content_type,
	})));

	async function loadEntries(): Promise<void> {
		// Auto-detect network if not specified
		if (!activeNetworkID) {
			try {
				const networks = await api.lishnets.list();
				const enabled = networks.filter(n => n.enabled);
				if (enabled.length > 0) {
					activeNetworkID = enabled[0]!.networkID;
					networkName = enabled[0]!.name;
				}
			} catch {}
		}
		if (!activeNetworkID) {
			entries = [];
			loading = false;
			error = 'No network joined. Enable a LISH network in Settings first.';
			return;
		}
		loading = true;
		error = null;
		try {
			if (searchQuery.trim()) {
				entries = await searchCatalog(activeNetworkID, searchQuery);
			} else {
				entries = await listCatalogEntries(activeNetworkID);
			}
		} catch (err: any) {
			error = err.message;
			entries = [];
		}
		loading = false;
	}

	let searchBar: SearchBar | undefined = $state();

	const searchNavHandle = createNavArea(() => ({
		areaID: searchAreaID,
		position: searchPosition,
		onBack,
	}));

	// Fallback nav area for loading/empty states — ensures ESC works even without ProductsList
	const fallbackNavHandle = createNavArea(() => ({
		areaID: `${areaID}-fallback`,
		position: listPosition,
		onBack,
		activate: items.length === 0,
	}));

	onMount(() => {
		loadEntries();
		const unsubNav = searchNavHandle.controller.register(
			navItem(
				() => [0, 0] as NavPos,
				() => undefined,
				() => searchBar?.toggleFocus()
			)
		);
		const unsubEvents = subscribeCatalogEvents({
			onUpdated: () => loadEntries(),
			onRemoved: () => loadEntries(),
		});
		return () => { unsubNav(); unsubEvents(); };
	});
</script>

<SearchBar bind:this={searchBar} bind:value={searchQuery} selected={searchNavHandle.controller.isSelected([0, 0])} onchange={() => loadEntries()} />
{#if loading}
	<div class="loading">Loading catalog...</div>
{:else if error}
	<div class="error">{error}</div>
{:else if items.length === 0}
	<div class="empty">{searchQuery ? 'No results found' : 'Catalog is empty'}</div>
{:else}
	<ProductsList areaID={listAreaID} position={listPosition} {title} {items} {onBack} />
{/if}

<style>
	.loading, .error, .empty {
		display: flex;
		justify-content: center;
		align-items: center;
		padding: 4vh;
		font-size: 2.5vh;
		color: var(--secondary-foreground);
		opacity: 0.7;
	}
	.error {
		color: #ff6b6b;
	}
</style>
