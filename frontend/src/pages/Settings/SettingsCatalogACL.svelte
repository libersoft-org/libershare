<script lang="ts">
	import { onMount } from 'svelte';
	import { t, translateError } from '../../scripts/language.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import { type LISHNetworkConfig } from '@shared';
	import { getCatalogAccess, grantCatalogRole, revokeCatalogRole, subscribeCatalogEvents, type CatalogACLResponse } from '../../scripts/catalog.ts';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import Alert from '../../components/Alert/Alert.svelte';
	import Spinner from '../../components/Spinner/Spinner.svelte';
	import Table from '../../components/Table/Table.svelte';
	import TableHeader from '../../components/Table/TableHeader.svelte';
	import TableRow from '../../components/Table/TableRow.svelte';
	import TableCell from '../../components/Table/TableCell.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		network: LISHNetworkConfig;
		onBack?: (() => void) | undefined;
	}
	let { areaID, position = LAYOUT.content, network, onBack }: Props = $props();
	let acl = $state<CatalogACLResponse | null>(null);
	let loading = $state(true);
	let error = $state('');
	let actionError = $state('');

	async function loadACL(): Promise<void> {
		loading = true;
		error = '';
		try {
			acl = await getCatalogAccess(network.networkID);
		} catch (e: any) {
			error = translateError(e);
			acl = null;
		}
		loading = false;
	}

	async function removeAdmin(peerID: string): Promise<void> {
		actionError = '';
		try {
			await revokeCatalogRole(network.networkID, peerID, 'admin');
			await loadACL();
		} catch (e: any) {
			actionError = translateError(e);
		}
	}

	async function removeModerator(peerID: string): Promise<void> {
		actionError = '';
		try {
			await revokeCatalogRole(network.networkID, peerID, 'moderator');
			await loadACL();
		} catch (e: any) {
			actionError = translateError(e);
		}
	}

	function shortenPeerID(id: string): string {
		if (id.length <= 20) return id;
		return `${id.slice(0, 12)}...${id.slice(-8)}`;
	}

	createNavArea(() => ({ areaID, position, onBack, activate: true }));

	onMount(() => {
		loadACL();
		const unsub = subscribeCatalogEvents({
			onACL: () => loadACL(),
		});
		return unsub;
	});
</script>

<style>
	.acl-panel {
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

	.remove-btn {
		cursor: pointer;
		color: #ff6b6b;
		font-size: 1.6vh;
		padding: 0.3vh 0.8vh;
		border: 1px solid #ff6b6b;
		border-radius: 0.5vh;
		background: transparent;
		transition: opacity 0.2s;
	}

	.remove-btn:hover {
		opacity: 0.7;
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
</style>

<div class="acl-panel">
	<div class="container">
		<ButtonBar>
			<Button icon="/img/back.svg" label={$t('common.back')} position={[0, 0]} onConfirm={onBack} width="auto" />
			<Button icon="/img/restart.svg" label={$t('common.refresh')} position={[1, 0]} onConfirm={loadACL} width="auto" />
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
							<TableRow position={[0, i + 1]} odd={i % 2 !== 0}>
								<TableCell desktopOnly>{i + 1}</TableCell>
								<TableCell wrap><span class="peer-id">{admin}</span></TableCell>
								<TableCell><button class="remove-btn" onclick={() => removeAdmin(admin)}>Remove</button></TableCell>
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
							<TableRow position={[0, i + 1]} odd={i % 2 !== 0}>
								<TableCell desktopOnly>{i + 1}</TableCell>
								<TableCell wrap><span class="peer-id">{mod}</span></TableCell>
								<TableCell><button class="remove-btn" onclick={() => removeModerator(mod)}>Remove</button></TableCell>
							</TableRow>
						{/each}
					</Table>
				{/if}
			</div>

			<div class="restrict-info">
				{#if acl.restrict_writes}
					Catalog is restricted — only owner, admins, and moderators can publish entries.
				{:else}
					Catalog is open — any peer can publish entries.
				{/if}
			</div>
		{/if}
	</div>
</div>
