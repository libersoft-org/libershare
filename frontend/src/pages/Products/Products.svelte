<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { CONTENT_OFFSETS } from '../../scripts/navigationLayout.ts';
	import { createNavArea, navItem, type NavPos } from '../../scripts/navArea.svelte.ts';
	import { activateArea } from '../../scripts/areas.ts';
	import { pushBreadcrumb, popBreadcrumb } from '../../scripts/navigation.ts';
	import { pushBackHandler } from '../../scripts/focus.ts';
	import SearchBar from '../../components/Search/SearchBar.svelte';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import Alert from '../../components/Alert/Alert.svelte';
	import Spinner from '../../components/Spinner/Spinner.svelte';
	import ProductsList from './ProductsList.svelte';
	import CatalogPublishPanel from './CatalogPublishPanel.svelte';
	import CatalogACLPanel from './CatalogACLPanel.svelte';
	import { listCatalogEntries, searchCatalog, subscribeCatalogEvents, getCatalogAccess, type CatalogEntryResponse, type CatalogACLResponse } from '../../scripts/catalog.ts';
	import { api } from '../../scripts/api.ts';

	interface Props {
		areaID: string;
		position: Position;
		title?: string;
		onBack?: () => void;
	}
	let { areaID, position, title = 'Library', onBack }: Props = $props();

	let activeNetworkID = $state('');
	let networkName = $state('');
	let entries = $state<CatalogEntryResponse[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let searchQuery = $state('');

	let currentView = $state<'catalog' | 'publish' | 'acl'>('catalog');
	let removeBackHandler: (() => void) | null = null;

	let items = $derived(entries.map(e => ({
		id: e.lish_id,
		title: e.name || e.lish_id,
		description: e.description,
		totalSize: e.total_size,
		fileCount: e.file_count,
		tags: e.tags,
		contentType: e.content_type,
	})));

	let searchAreaID = $derived(`${areaID}-search`);
	let listAreaID = $derived(`${areaID}-list`);
	let panelAreaID = $derived(`${areaID}-panel`);
	let searchPosition = $derived({ x: position.x + CONTENT_OFFSETS.top.x, y: position.y + CONTENT_OFFSETS.top.y });
	let toolbarPosition = $derived({ x: position.x + CONTENT_OFFSETS.main.x, y: position.y + CONTENT_OFFSETS.main.y });
	let listPosition = $derived({ x: position.x + CONTENT_OFFSETS.main.x, y: position.y + CONTENT_OFFSETS.main.y + 1 });

	async function loadEntries(): Promise<void> {
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
			entries = searchQuery.trim()
				? await searchCatalog(activeNetworkID, searchQuery)
				: await listCatalogEntries(activeNetworkID);
		} catch (err: any) {
			error = err.message;
			entries = [];
		}
		loading = false;
	}

	function openPublishPanel(): void {
		currentView = 'publish';
		mainNav.pause();
		pushBreadcrumb('Publish');
		removeBackHandler = pushBackHandler(closePanel);
	}

	function openACLPanel(): void {
		currentView = 'acl';
		mainNav.pause();
		pushBreadcrumb('Permissions');
		removeBackHandler = pushBackHandler(closePanel);
	}

	async function closePanel(): Promise<void> {
		if (removeBackHandler) { removeBackHandler(); removeBackHandler = null; }
		popBreadcrumb();
		currentView = 'catalog';
		await tick();
		mainNav.resume();
		activateArea(areaID);
	}

	let searchBar: SearchBar | undefined = $state();

	const searchNavHandle = createNavArea(() => ({
		areaID: searchAreaID,
		position: searchPosition,
		onBack,
	}));

	// Single navArea for catalog view — toolbar buttons register here via context
	const mainNav = createNavArea(() => ({
		areaID,
		position: toolbarPosition,
		onBack,
		activate: currentView === 'catalog',
	}));

	onMount(() => {
		loadEntries();
		const unsubSearch = searchNavHandle.controller.register(
			navItem(() => [0, 0] as NavPos, () => undefined, () => searchBar?.toggleFocus())
		);
		const unsubEvents = subscribeCatalogEvents({
			onUpdated: () => loadEntries(),
			onRemoved: () => loadEntries(),
		});
		return () => { unsubSearch(); unsubEvents(); };
	});
</script>

<style>
	.catalog-page {
		display: flex;
		flex-direction: column;
		width: 100%;
		height: 100%;
		overflow: hidden;
	}

	.catalog-content {
		flex: 1;
		overflow-y: auto;
		padding: 1vh;
	}

	.status-bar {
		display: flex;
		align-items: center;
		gap: 1vh;
		padding: 0.5vh 2vh;
		font-size: 1.6vh;
		color: var(--disabled-foreground);
	}

	.loading-center, .empty-center {
		display: flex;
		justify-content: center;
		align-items: center;
		padding: 6vh;
		font-size: 2.5vh;
		color: var(--secondary-foreground);
		opacity: 0.6;
	}
</style>

<div class="catalog-page">
	<SearchBar bind:this={searchBar} bind:value={searchQuery} selected={searchNavHandle.controller.isSelected([0, 0])} onchange={() => loadEntries()} />

	{#if currentView === 'catalog'}
		<ButtonBar>
			<Button icon="/img/plus.svg" label="Publish" position={[0, 0]} onConfirm={openPublishPanel} />
			<Button icon="/img/settings.svg" label="Permissions" position={[1, 0]} onConfirm={openACLPanel} />
		</ButtonBar>

		{#if networkName}
			<div class="status-bar">{networkName} — {entries.length} entries</div>
		{/if}

		<div class="catalog-content">
			{#if loading}
				<div class="loading-center"><Spinner size="6vh" /></div>
			{:else if error}
				<Alert type="error" message={error} />
			{:else if items.length === 0}
				<div class="empty-center">{searchQuery ? 'No results found' : 'Catalog is empty — use Publish to add entries'}</div>
			{:else}
				<ProductsList areaID={listAreaID} position={listPosition} {title} {items} {onBack} />
			{/if}
		</div>

	{:else if currentView === 'publish'}
		<CatalogPublishPanel areaID={panelAreaID} position={toolbarPosition} networkID={activeNetworkID} onBack={closePanel} onPublished={loadEntries} />

	{:else if currentView === 'acl'}
		<CatalogACLPanel areaID={panelAreaID} position={toolbarPosition} networkID={activeNetworkID} onBack={closePanel} />
	{/if}
</div>
