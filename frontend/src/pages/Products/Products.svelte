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
	import Table from '../../components/Table/Table.svelte';
	import TableHeader from '../../components/Table/TableHeader.svelte';
	import TableRow from '../../components/Table/TableRow.svelte';
	import TableCell from '../../components/Table/TableCell.svelte';
	import ProductsList from './ProductsList.svelte';
	import { listCatalogEntries, searchCatalog, subscribeCatalogEvents, getCatalogAccess, publishCatalogEntry, grantCatalogRole, revokeCatalogRole, type CatalogEntryResponse, type CatalogACLResponse } from '../../scripts/catalog.ts';
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

	let currentView = $state<'catalog' | 'publish' | 'acl'>('catalog');
	let publishError = $state('');
	let publishSuccess = $state('');
	let aclError = $state('');
	let localLISHs = $state<{ id: string; name?: string | undefined }[]>([]);
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
		api.lishs.list().then(r => { localLISHs = r.items.map(l => ({ id: l.id, name: l.name ?? undefined })); }).catch(e => { publishError = e.message; });
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
				lishID, name: name || lishID, description: detail.description ?? undefined,
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
		aclError = '';
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
		color: var(--disabled-foreground);
	}

	.panel {
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

	.section {
		display: flex;
		flex-direction: column;
		gap: 1vh;
	}

	.section-title {
		font-size: 2.5vh;
		font-weight: bold;
		color: var(--secondary-foreground);
		padding: 1vh 0;
	}

	.owner-info {
		display: flex;
		flex-direction: column;
		gap: 0.5vh;
		padding: 1.5vh;
		background-color: var(--secondary-soft-background);
		border-radius: 1vh;
	}

	.owner-label {
		font-size: 1.6vh;
		color: var(--secondary-foreground);
		opacity: 0.7;
	}

	.owner-id {
		font-family: monospace;
		font-size: 1.8vh;
		word-break: break-all;
		color: var(--secondary-foreground);
	}

	.peer-id {
		font-family: monospace;
		font-size: 1.6vh;
		word-break: break-all;
		white-space: normal;
	}

	.empty-msg {
		font-size: 1.8vh;
		color: var(--secondary-foreground);
		opacity: 0.5;
		padding: 1vh;
	}

	.restrict-info {
		font-size: 1.6vh;
		padding: 1vh;
		background-color: var(--secondary-soft-background);
		border-radius: 0.5vh;
		color: var(--secondary-foreground);
		opacity: 0.8;
	}

	.add-role-section {
		display: flex;
		gap: 1vh;
		align-items: flex-end;
		flex-wrap: wrap;
	}

	.lish-name {
		font-size: 2vh;
		color: var(--secondary-foreground);
	}

	.lish-meta {
		font-size: 1.4vh;
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
		<div class="panel">
			<div class="container">
				<ButtonBar>
					<Button icon="/img/back.svg" label="Back" position={[0, 0]} onConfirm={closePanel} />
				</ButtonBar>

				{#if publishError}
					<Alert type="error" message={publishError} />
				{/if}
				{#if publishSuccess}
					<Alert type="info" message={publishSuccess} />
				{/if}

				<div class="section">
					<div class="section-title">Publish LISH to Catalog</div>

					{#if localLISHs.length === 0}
						<div class="empty-msg">No local LISHs found. Create one in Downloads first.</div>
					{:else}
						{#each localLISHs as lish, i}
							<Row selected={panelNav.controller.isYSelected(i + 1)}>
								<div style="display: flex; justify-content: space-between; align-items: center; width: 100%; gap: 2vh;">
									<div>
										<div class="lish-name">{lish.name || lish.id}</div>
									</div>
									<Button label="Publish" position={[0, i + 1]} onConfirm={() => publishLISH(lish.id, lish.name)} width="auto" />
								</div>
							</Row>
						{/each}
					{/if}
				</div>
			</div>
		</div>

	{:else if currentView === 'acl'}
		<div class="panel">
			<div class="container">
				<ButtonBar>
					<Button icon="/img/back.svg" label="Back" position={[0, 0]} onConfirm={closePanel} />
					<Button icon="/img/restart.svg" label="Refresh" position={[1, 0]} onConfirm={loadEntries} width="auto" />
				</ButtonBar>

				{#if aclError}
					<Alert type="error" message={aclError} />
				{/if}

				{#if acl}
					<div class="section">
						<div class="section-title">Owner</div>
						<div class="owner-info">
							<span class="owner-label">Network Owner (immutable)</span>
							<span class="owner-id">{acl.owner}</span>
						</div>
					</div>

					<div class="section">
						<div class="section-title">Admins ({acl.admins.length})</div>
						{#if acl.admins.length === 0}
							<div class="empty-msg">No admins assigned</div>
						{:else}
							<Table columns="auto 1fr auto" columnsMobile="1fr auto">
								<TableHeader>
									<TableCell desktopOnly>#</TableCell>
									<TableCell>Peer ID</TableCell>
									<TableCell>Action</TableCell>
								</TableHeader>
								{#each acl.admins as admin, i}
									<TableRow position={[0, i + 2]} odd={i % 2 !== 0}>
										<TableCell desktopOnly>{i + 1}</TableCell>
										<TableCell wrap><span class="peer-id">{admin}</span></TableCell>
										<TableCell><Button label="Remove" position={[1, i + 2]} onConfirm={() => removeRole(admin, 'admin')} width="auto" padding="0.8vh" fontSize="1.4vh" /></TableCell>
									</TableRow>
								{/each}
							</Table>
						{/if}
					</div>

					<div class="section">
						<div class="section-title">Moderators ({acl.moderators.length})</div>
						{#if acl.moderators.length === 0}
							<div class="empty-msg">No moderators assigned</div>
						{:else}
							<Table columns="auto 1fr auto" columnsMobile="1fr auto">
								<TableHeader>
									<TableCell desktopOnly>#</TableCell>
									<TableCell>Peer ID</TableCell>
									<TableCell>Action</TableCell>
								</TableHeader>
								{#each acl.moderators as mod, i}
									{@const modY = acl.admins.length + 3 + i}
									<TableRow position={[0, modY]} odd={i % 2 !== 0}>
										<TableCell desktopOnly>{i + 1}</TableCell>
										<TableCell wrap><span class="peer-id">{mod}</span></TableCell>
										<TableCell><Button label="Remove" position={[1, modY]} onConfirm={() => removeRole(mod, 'moderator')} width="auto" padding="0.8vh" fontSize="1.4vh" /></TableCell>
									</TableRow>
								{/each}
							</Table>
						{/if}
					</div>

					<div class="section">
						<div class="section-title">Add Role</div>
						<div class="add-role-section">
							<Input bind:value={newRolePeerID} placeholder="Peer ID (12D3KooW...)" position={[0, 20]} flex />
							<Button label="+ Admin" position={[1, 20]} onConfirm={() => addRole('admin')} width="auto" />
							<Button label="+ Moderator" position={[2, 20]} onConfirm={() => addRole('moderator')} width="auto" />
						</div>
					</div>

					<div class="restrict-info">
						Catalog is open — any peer can publish entries.
					</div>
				{:else}
					<Alert type="warning" message="Catalog not available for this network" />
				{/if}
			</div>
		</div>
	{/if}
</div>
