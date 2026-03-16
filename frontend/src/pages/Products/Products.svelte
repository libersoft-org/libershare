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
	import Input from '../../components/Input/Input.svelte';
	import Row from '../../components/Row/Row.svelte';
	import Alert from '../../components/Alert/Alert.svelte';
	import Spinner from '../../components/Spinner/Spinner.svelte';
	import ProductsList from './ProductsList.svelte';
	import { listCatalogEntries, searchCatalog, subscribeCatalogEvents, getCatalogAccess, publishCatalogEntry, grantCatalogRole, revokeCatalogRole, removeCatalogEntry, type CatalogEntryResponse, type CatalogACLResponse } from '../../scripts/catalog.ts';
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
	let acl = $state<CatalogACLResponse | null>(null);

	// Panel state
	let currentView = $state<'catalog' | 'publish' | 'acl'>('catalog');
	let publishError = $state('');
	let publishSuccess = $state('');
	let aclError = $state('');
	let localLISHs = $state<{ id: string; name?: string }[]>([]);
	let newRolePeerID = $state('');
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

	// Layout positions
	let searchAreaID = $derived(`${areaID}-search`);
	let toolbarAreaID = $derived(`${areaID}-toolbar`);
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
			error = 'No network joined';
			return;
		}
		loading = true;
		error = null;
		try {
			entries = searchQuery.trim()
				? await searchCatalog(activeNetworkID, searchQuery)
				: await listCatalogEntries(activeNetworkID);
			acl = await getCatalogAccess(activeNetworkID);
		} catch (err: any) {
			error = err.message;
			entries = [];
		}
		loading = false;
	}

	function openPublishPanel(): void {
		currentView = 'publish';
		publishError = '';
		publishSuccess = '';
		mainNav.pause();
		pushBreadcrumb('Publish');
		removeBackHandler = pushBackHandler(closePanel);
		api.lishs.list().then(r => { localLISHs = r.items.map(l => ({ id: l.id, name: l.name })); }).catch(e => { publishError = e.message; });
	}

	function openACLPanel(): void {
		currentView = 'acl';
		aclError = '';
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

	async function publishLISH(lishID: string, name: string | undefined): Promise<void> {
		publishError = '';
		publishSuccess = '';
		try {
			const detail = await api.lishs.get(lishID);
			if (!detail) { publishError = 'LISH not found'; return; }
			await publishCatalogEntry(activeNetworkID, {
				lishID, name: name || lishID, description: detail.description,
				chunkSize: detail.chunkSize, checksumAlgo: detail.checksumAlgo,
				totalSize: detail.totalSize, fileCount: detail.fileCount,
				manifestHash: `sha256:${lishID}`,
			});
			publishSuccess = `Published "${name || lishID}"`;
			await loadEntries();
		} catch (e: any) { publishError = e.message; }
	}

	async function addRole(role: 'admin' | 'moderator'): Promise<void> {
		aclError = '';
		if (!newRolePeerID.trim()) { aclError = 'Enter a Peer ID'; return; }
		try {
			await grantCatalogRole(activeNetworkID, newRolePeerID.trim(), role);
			newRolePeerID = '';
			acl = await getCatalogAccess(activeNetworkID);
		} catch (e: any) { aclError = e.message; }
	}

	async function removeRole(peerID: string, role: 'admin' | 'moderator'): Promise<void> {
		try {
			await revokeCatalogRole(activeNetworkID, peerID, role);
			acl = await getCatalogAccess(activeNetworkID);
		} catch (e: any) { aclError = e.message; }
	}

	let searchBar: SearchBar | undefined = $state();

	const searchNavHandle = createNavArea(() => ({
		areaID: searchAreaID,
		position: searchPosition,
		onBack,
	}));

	const mainNav = createNavArea(() => ({
		areaID,
		position: toolbarPosition,
		onBack,
		activate: currentView === 'catalog',
	}));

	const panelNav = createNavArea(() => ({
		areaID: panelAreaID,
		position: toolbarPosition,
		onBack: closePanel,
		activate: currentView !== 'catalog',
	}));

	onMount(() => {
		loadEntries();
		const unsubSearch = searchNavHandle.controller.register(
			navItem(() => [0, 0] as NavPos, () => undefined, () => searchBar?.toggleFocus())
		);
		const unsubEvents = subscribeCatalogEvents({
			onUpdated: () => loadEntries(),
			onRemoved: () => loadEntries(),
			onACL: (data) => { acl = data.access; },
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
		color: var(--secondary-foreground);
		opacity: 0.5;
	}
	.panel-content {
		display: flex;
		flex-direction: column;
		gap: 1.5vh;
		padding: 2vh;
		max-width: 1200px;
		width: 100%;
		align-self: center;
	}
	.section-label {
		font-size: 2vh;
		font-weight: bold;
		color: var(--secondary-foreground);
		padding: 0.5vh 0;
	}
	.peer-id-text {
		font-family: monospace;
		font-size: 1.4vh;
		word-break: break-all;
		color: var(--secondary-foreground);
		padding: 0.5vh 0;
	}
	.role-row {
		display: flex;
		align-items: center;
		gap: 1vh;
		width: 100%;
	}
	.role-row .peer-text {
		flex: 1;
		font-family: monospace;
		font-size: 1.4vh;
		word-break: break-all;
		color: var(--secondary-foreground);
	}
	.add-role-row {
		display: flex;
		gap: 1vh;
		align-items: center;
		flex-wrap: wrap;
	}
	.empty-text {
		font-size: 1.6vh;
		color: var(--secondary-foreground);
		opacity: 0.5;
		padding: 1vh 0;
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
		<!-- TOOLBAR -->
		<ButtonBar>
			<Button icon="/img/plus.svg" label="Publish" position={[0, 0]} onConfirm={openPublishPanel} width="auto" />
			<Button icon="/img/settings.svg" label="Permissions" position={[1, 0]} onConfirm={openACLPanel} width="auto" />
		</ButtonBar>

		{#if networkName}
			<div class="status-bar">{networkName} — {entries.length} entries</div>
		{/if}

		<!-- CATALOG CONTENT -->
		<div class="catalog-content">
			{#if loading}
				<div class="loading-center"><Spinner size="6vh" /></div>
			{:else if error}
				<Alert type="error" message={error} />
			{:else if items.length === 0}
				<div class="empty-center">{searchQuery ? 'No results' : 'Catalog is empty — use Publish to add entries'}</div>
			{:else}
				<ProductsList areaID={listAreaID} position={listPosition} {title} {items} {onBack} />
			{/if}
		</div>

	{:else if currentView === 'publish'}
		<!-- PUBLISH PANEL -->
		<div class="catalog-content">
			<div class="panel-content">
				<ButtonBar>
					<Button icon="/img/back.svg" label="Back" position={[0, 0]} onConfirm={closePanel} width="auto" />
				</ButtonBar>

				<Alert type="error" message={publishError} />
				<Alert type="info" message={publishSuccess} />

				<div class="section-label">Select a local LISH to publish to catalog:</div>

				{#if localLISHs.length === 0}
					<div class="empty-text">No local LISHs found. Create one in Downloads first.</div>
				{:else}
					{#each localLISHs as lish, i}
						<Row selected={panelNav.controller.isYSelected(i + 1)}>
							<div class="role-row">
								<span class="role-row peer-text">{lish.name || lish.id}</span>
								<Button label="Publish" position={[0, i + 1]} onConfirm={() => publishLISH(lish.id, lish.name)} width="auto" padding="1vh" fontSize="1.6vh" />
							</div>
						</Row>
					{/each}
				{/if}
			</div>
		</div>

	{:else if currentView === 'acl'}
		<!-- ACL PANEL -->
		<div class="catalog-content">
			<div class="panel-content">
				<ButtonBar>
					<Button icon="/img/back.svg" label="Back" position={[0, 0]} onConfirm={closePanel} width="auto" />
				</ButtonBar>

				<Alert type="error" message={aclError} />

				{#if acl}
					<div class="section-label">Owner</div>
					<Row>
						<div class="peer-id-text">{acl.owner}</div>
					</Row>

					<div class="section-label">Admins ({acl.admins.length})</div>
					{#if acl.admins.length === 0}
						<div class="empty-text">No admins assigned</div>
					{:else}
						{#each acl.admins as admin, i}
							<Row selected={panelNav.controller.isYSelected(i + 2)}>
								<div class="role-row">
									<span class="peer-text">{admin}</span>
									<Button label="Remove" position={[0, i + 2]} onConfirm={() => removeRole(admin, 'admin')} width="auto" padding="0.8vh" fontSize="1.4vh" />
								</div>
							</Row>
						{/each}
					{/if}

					<div class="section-label">Moderators ({acl.moderators.length})</div>
					{#if acl.moderators.length === 0}
						<div class="empty-text">No moderators assigned</div>
					{:else}
						{#each acl.moderators as mod, i}
							{@const rowY = (acl?.admins.length ?? 0) + i + 3}
							<Row selected={panelNav.controller.isYSelected(rowY)}>
								<div class="role-row">
									<span class="peer-text">{mod}</span>
									<Button label="Remove" position={[0, rowY]} onConfirm={() => removeRole(mod, 'moderator')} width="auto" padding="0.8vh" fontSize="1.4vh" />
								</div>
							</Row>
						{/each}
					{/if}

					<div class="section-label">Add Role</div>
					<div class="add-role-row">
						<Input bind:value={newRolePeerID} placeholder="Peer ID (12D3KooW...)" fontSize="1.6vh" padding="0.8vh 1vh" flex position={[0, 20]} />
						<Button label="+ Admin" position={[1, 20]} onConfirm={() => addRole('admin')} width="auto" padding="0.8vh" fontSize="1.4vh" />
						<Button label="+ Moderator" position={[2, 20]} onConfirm={() => addRole('moderator')} width="auto" padding="0.8vh" fontSize="1.4vh" />
					</div>
				{:else}
					<Alert type="warning" message="No catalog available for this network" />
				{/if}
			</div>
		</div>
	{/if}
</div>
