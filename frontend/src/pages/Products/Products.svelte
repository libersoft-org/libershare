<script lang="ts">
	import { onMount } from 'svelte';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { CONTENT_OFFSETS } from '../../scripts/navigationLayout.ts';
	import { createNavArea, navItem, type NavPos } from '../../scripts/navArea.svelte.ts';
	import SearchBar from '../../components/Search/SearchBar.svelte';
	import ProductsList from './ProductsList.svelte';
	import { listCatalogEntries, searchCatalog, subscribeCatalogEvents, getCatalogAccess, publishCatalogEntry, grantCatalogRole, revokeCatalogRole, removeCatalogEntry, type CatalogEntryResponse, type CatalogACLResponse } from '../../scripts/catalog.ts';
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
	let acl = $state<CatalogACLResponse | null>(null);
	let showPanel = $state<'none' | 'publish' | 'acl'>('none');
	let publishError = $state('');
	let publishSuccess = $state('');
	let aclError = $state('');
	let localLISHs = $state<{ id: string; name?: string }[]>([]);
	let newRolePeerID = $state('');
	let newRoleType = $state<'admin' | 'moderator'>('moderator');

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
			acl = await getCatalogAccess(activeNetworkID);
		} catch (err: any) {
			error = err.message;
			entries = [];
		}
		loading = false;
	}

	async function openPublishPanel(): Promise<void> {
		showPanel = 'publish';
		publishError = '';
		publishSuccess = '';
		try {
			const result = await api.lishs.list();
			localLISHs = result.items.map(l => ({ id: l.id, name: l.name }));
		} catch (e: any) {
			publishError = e.message;
		}
	}

	async function publishLISH(lishID: string, name: string | undefined): Promise<void> {
		publishError = '';
		publishSuccess = '';
		try {
			const detail = await api.lishs.get(lishID);
			if (!detail) { publishError = 'LISH not found'; return; }
			await publishCatalogEntry(activeNetworkID, {
				lishID,
				name: name || lishID,
				description: detail.description,
				chunkSize: detail.chunkSize,
				checksumAlgo: detail.checksumAlgo,
				totalSize: detail.totalSize,
				fileCount: detail.fileCount,
				manifestHash: `sha256:${lishID}`,
			});
			publishSuccess = `Published "${name || lishID}" to catalog`;
			await loadEntries();
		} catch (e: any) {
			publishError = e.message;
		}
	}

	async function addRole(): Promise<void> {
		aclError = '';
		if (!newRolePeerID.trim()) { aclError = 'Enter a Peer ID'; return; }
		try {
			await grantCatalogRole(activeNetworkID, newRolePeerID.trim(), newRoleType);
			newRolePeerID = '';
			acl = await getCatalogAccess(activeNetworkID);
		} catch (e: any) {
			aclError = e.message;
		}
	}

	async function removeRole(peerID: string, role: 'admin' | 'moderator'): Promise<void> {
		aclError = '';
		try {
			await revokeCatalogRole(activeNetworkID, peerID, role);
			acl = await getCatalogAccess(activeNetworkID);
		} catch (e: any) {
			aclError = e.message;
		}
	}

	async function removeEntry(lishID: string): Promise<void> {
		try {
			await removeCatalogEntry(activeNetworkID, lishID);
			await loadEntries();
		} catch {}
	}

	let searchBar: SearchBar | undefined = $state();

	const searchNavHandle = createNavArea(() => ({
		areaID: searchAreaID,
		position: searchPosition,
		onBack,
	}));

	const fallbackNavHandle = createNavArea(() => ({
		areaID: `${areaID}-fallback`,
		position: listPosition,
		onBack,
		activate: items.length === 0 && showPanel === 'none',
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
			onACL: (data) => { acl = data.access; },
		});
		return () => { unsubNav(); unsubEvents(); };
	});
</script>

<style>
	.toolbar {
		display: flex;
		gap: 1vh;
		padding: 1vh 2vh;
		flex-wrap: wrap;
	}
	.toolbar button {
		padding: 0.8vh 1.5vh;
		border: 1px solid var(--secondary-softer-background);
		border-radius: 1vh;
		background: var(--secondary-soft-background);
		color: var(--secondary-foreground);
		font-size: 1.8vh;
		cursor: pointer;
		transition: opacity 0.2s;
	}
	.toolbar button:hover { opacity: 0.7; }
	.toolbar button.active {
		border-color: var(--primary-foreground);
		background: var(--primary-background);
		color: var(--primary-foreground);
	}
	.toolbar .net-name {
		font-size: 1.6vh;
		color: var(--secondary-foreground);
		opacity: 0.5;
		align-self: center;
		margin-left: auto;
	}

	.panel {
		padding: 2vh;
		background: var(--secondary-background);
		border-bottom: 1px solid var(--secondary-softer-background);
		max-height: 50vh;
		overflow-y: auto;
	}
	.panel h3 {
		margin: 0 0 1vh 0;
		font-size: 2.2vh;
		color: var(--secondary-foreground);
	}
	.panel .error { color: #ff6b6b; font-size: 1.6vh; margin: 0.5vh 0; }
	.panel .success { color: #51cf66; font-size: 1.6vh; margin: 0.5vh 0; }

	.lish-list {
		display: flex;
		flex-direction: column;
		gap: 0.5vh;
	}
	.lish-item {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 1vh;
		background: var(--secondary-soft-background);
		border-radius: 0.5vh;
	}
	.lish-item .name { font-size: 1.8vh; color: var(--secondary-foreground); }
	.lish-item button {
		padding: 0.4vh 1vh;
		border: 1px solid var(--primary-foreground);
		border-radius: 0.5vh;
		background: transparent;
		color: var(--primary-foreground);
		font-size: 1.4vh;
		cursor: pointer;
	}

	.acl-section { margin-bottom: 1.5vh; }
	.acl-section .label {
		font-size: 1.6vh;
		color: var(--secondary-foreground);
		opacity: 0.6;
		margin-bottom: 0.5vh;
	}
	.acl-list { display: flex; flex-direction: column; gap: 0.3vh; }
	.acl-peer {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 0.6vh 1vh;
		background: var(--secondary-soft-background);
		border-radius: 0.3vh;
		font-family: monospace;
		font-size: 1.4vh;
		word-break: break-all;
	}
	.acl-peer button {
		padding: 0.3vh 0.8vh;
		border: 1px solid #ff6b6b;
		border-radius: 0.3vh;
		background: transparent;
		color: #ff6b6b;
		font-size: 1.2vh;
		cursor: pointer;
		flex-shrink: 0;
		margin-left: 1vh;
	}
	.add-role {
		display: flex;
		gap: 0.5vh;
		margin-top: 1vh;
		flex-wrap: wrap;
	}
	.add-role input {
		flex: 1;
		min-width: 20vh;
		padding: 0.6vh 1vh;
		border: 1px solid var(--secondary-softer-background);
		border-radius: 0.3vh;
		background: var(--secondary-soft-background);
		color: var(--secondary-foreground);
		font-family: monospace;
		font-size: 1.4vh;
	}
	.add-role select {
		padding: 0.6vh;
		border: 1px solid var(--secondary-softer-background);
		border-radius: 0.3vh;
		background: var(--secondary-soft-background);
		color: var(--secondary-foreground);
		font-size: 1.4vh;
	}
	.add-role button {
		padding: 0.6vh 1.2vh;
		border: 1px solid var(--primary-foreground);
		border-radius: 0.3vh;
		background: var(--primary-background);
		color: var(--primary-foreground);
		font-size: 1.4vh;
		cursor: pointer;
	}

	.loading, .error-msg, .empty {
		display: flex;
		justify-content: center;
		align-items: center;
		padding: 4vh;
		font-size: 2.5vh;
		color: var(--secondary-foreground);
		opacity: 0.7;
	}
	.error-msg { color: #ff6b6b; }
</style>

<SearchBar bind:this={searchBar} bind:value={searchQuery} selected={searchNavHandle.controller.isSelected([0, 0])} onchange={() => loadEntries()} />

<div class="toolbar">
	<button class:active={showPanel === 'publish'} onclick={() => showPanel = showPanel === 'publish' ? 'none' : 'publish'}>+ Publish</button>
	<button class:active={showPanel === 'acl'} onclick={() => showPanel = showPanel === 'acl' ? 'none' : 'acl'}>Permissions</button>
	{#if networkName}
		<span class="net-name">{networkName}</span>
	{/if}
</div>

{#if showPanel === 'publish'}
	<div class="panel">
		<h3>Publish LISH to Catalog</h3>
		{#if publishError}<div class="error">{publishError}</div>{/if}
		{#if publishSuccess}<div class="success">{publishSuccess}</div>{/if}
		{#if localLISHs.length === 0}
			<div style="font-size: 1.8vh; opacity: 0.6;">No local LISHs. Create one in Downloads first.</div>
		{:else}
			<div class="lish-list">
				{#each localLISHs as lish}
					<div class="lish-item">
						<span class="name">{lish.name || lish.id}</span>
						<button onclick={() => publishLISH(lish.id, lish.name)}>Publish</button>
					</div>
				{/each}
			</div>
		{/if}
	</div>
{/if}

{#if showPanel === 'acl'}
	<div class="panel">
		<h3>Catalog Permissions</h3>
		{#if aclError}<div class="error">{aclError}</div>{/if}
		{#if acl}
			<div class="acl-section">
				<div class="label">Owner (immutable)</div>
				<div class="acl-peer">{acl.owner}</div>
			</div>
			<div class="acl-section">
				<div class="label">Admins ({acl.admins.length})</div>
				{#if acl.admins.length > 0}
					<div class="acl-list">
						{#each acl.admins as admin}
							<div class="acl-peer">
								{admin}
								<button onclick={() => removeRole(admin, 'admin')}>Remove</button>
							</div>
						{/each}
					</div>
				{:else}
					<div style="font-size: 1.4vh; opacity: 0.5;">No admins</div>
				{/if}
			</div>
			<div class="acl-section">
				<div class="label">Moderators ({acl.moderators.length})</div>
				{#if acl.moderators.length > 0}
					<div class="acl-list">
						{#each acl.moderators as mod}
							<div class="acl-peer">
								{mod}
								<button onclick={() => removeRole(mod, 'moderator')}>Remove</button>
							</div>
						{/each}
					</div>
				{:else}
					<div style="font-size: 1.4vh; opacity: 0.5;">No moderators</div>
				{/if}
			</div>
			<div class="add-role">
				<input bind:value={newRolePeerID} placeholder="Peer ID (12D3KooW...)" />
				<select bind:value={newRoleType}>
					<option value="moderator">Moderator</option>
					<option value="admin">Admin</option>
				</select>
				<button onclick={addRole}>Add</button>
			</div>
		{:else}
			<div style="font-size: 1.6vh; opacity: 0.5;">No catalog ACL available</div>
		{/if}
	</div>
{/if}

{#if loading}
	<div class="loading">Loading catalog...</div>
{:else if error}
	<div class="error-msg">{error}</div>
{:else if items.length === 0}
	<div class="empty">{searchQuery ? 'No results found' : 'Catalog is empty — use Publish to add entries'}</div>
{:else}
	<ProductsList areaID={listAreaID} position={listPosition} {title} {items} {onBack} />
{/if}
