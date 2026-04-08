<script lang="ts">
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import Input from '../../components/Input/Input.svelte';
	import Alert from '../../components/Alert/Alert.svelte';
	import Spinner from '../../components/Spinner/Spinner.svelte';
	import Table from '../../components/Table/Table.svelte';
	import TableHeader from '../../components/Table/TableHeader.svelte';
	import TableRow from '../../components/Table/TableRow.svelte';
	import TableCell from '../../components/Table/TableCell.svelte';
	import { getCatalogAccess, grantCatalogRole, revokeCatalogRole, subscribeCatalogEvents, type CatalogACLResponse } from '../../scripts/catalog.ts';
	import { onMount } from 'svelte';

	interface Props {
		areaID: string;
		position: Position;
		networkID: string;
		onBack?: () => void;
	}
	let { areaID, position, networkID, onBack }: Props = $props();

	let acl = $state<CatalogACLResponse | null>(null);
	let loading = $state(true);
	let error = $state('');
	let actionError = $state('');
	let newRolePeerID = $state('');

	const navHandle = createNavArea(() => ({ areaID, position, onBack, activate: true }));

	async function loadACL(): Promise<void> {
		loading = true;
		error = '';
		try {
			acl = await getCatalogAccess(networkID);
		} catch (e: any) {
			error = e.message;
			acl = null;
		}
		loading = false;
	}

	async function addRole(role: 'admin' | 'moderator'): Promise<void> {
		actionError = '';
		if (!newRolePeerID.trim()) { actionError = 'Enter a Peer ID'; return; }
		try {
			await grantCatalogRole(networkID, newRolePeerID.trim(), role);
			newRolePeerID = '';
			acl = await getCatalogAccess(networkID);
		} catch (e: any) { actionError = e.message; }
	}

	async function removeRole(peerID: string, role: 'admin' | 'moderator'): Promise<void> {
		actionError = '';
		try {
			await revokeCatalogRole(networkID, peerID, role);
			acl = await getCatalogAccess(networkID);
		} catch (e: any) { actionError = e.message; }
	}

	onMount(() => {
		loadACL();
		const unsub = subscribeCatalogEvents({ onACL: () => loadACL() });
		return unsub;
	});
</script>

<style>
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
</style>

<div class="panel">
	<div class="container">
		<ButtonBar>
			<Button icon="/img/back.svg" label="Back" position={[0, 0]} onConfirm={onBack} />
			<Button icon="/img/restart.svg" label="Refresh" position={[1, 0]} onConfirm={loadACL} width="auto" />
		</ButtonBar>

		{#if actionError}
			<Alert type="error" message={actionError} />
		{/if}

		{#if loading}
			<Spinner size="8vh" />
		{:else if error}
			<Alert type="error" message={error} />
		{:else if !acl}
			<Alert type="warning" message="Catalog not available for this network" />
		{:else}
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
		{/if}
	</div>
</div>
