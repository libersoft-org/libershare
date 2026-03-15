<script lang="ts">
	import { onMount } from 'svelte';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { CONTENT_OFFSETS } from '../../scripts/navigationLayout.ts';
	import { createNavArea, navItem, type NavPos } from '../../scripts/navArea.svelte.ts';
	import SearchBar from '../../components/Search/SearchBar.svelte';
	import ProductsList from './ProductsList.svelte';
	import { listCatalogEntries, searchCatalog, subscribeCatalogEvents, type CatalogEntryResponse } from '../../scripts/catalog.ts';
	interface Props {
		areaID: string;
		position: Position;
		title?: string;
		category?: string;
		networkID?: string;
		onBack?: () => void;
	}
	let { areaID, position, title = 'Library', networkID, onBack }: Props = $props();
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
		if (!networkID) {
			entries = [];
			loading = false;
			return;
		}
		loading = true;
		error = null;
		try {
			if (searchQuery.trim()) {
				entries = await searchCatalog(networkID, searchQuery);
			} else {
				entries = await listCatalogEntries(networkID);
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

<SearchBar bind:this={searchBar} selected={searchNavHandle.controller.isSelected([0, 0])} />
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
