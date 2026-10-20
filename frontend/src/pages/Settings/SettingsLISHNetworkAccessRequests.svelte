<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { t, translateError, tt } from '../../scripts/language.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import { createSubPage } from '../../scripts/subPage.svelte.ts';
	import { addNotification } from '../../scripts/notifications.ts';
	import { copyToClipboard } from '../../scripts/clipboard.ts';
	import { shortenPeerID } from '../../scripts/utils.ts';
	import { api } from '../../scripts/api.ts';
	import { type LISHNetworkConfig, type OverlayPendingRequest, type OverlayRole } from '@shared';
	import Alert from '../../components/Alert/Alert.svelte';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import Input from '../../components/Input/Input.svelte';
	import SwitchRow from '../../components/Switch/SwitchRow.svelte';
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
	const DEFAULT_DAYS = '365';

	let requests = $state<OverlayPendingRequest[]>([]);
	let pasted = $state('');
	let busy = $state(false);
	let selected = $state<OverlayPendingRequest | null>(null);
	let days = $state(DEFAULT_DAYS);
	let lighthouse = $state(false);
	let relay = $state(false);
	let heldRoles = $state<OverlayRole[]>([]);
	let issued = $state<{ name: string; certificate: string; byInvite: boolean; renewal: boolean } | null>(null);

	function approvedText(i: { byInvite: boolean; renewal: boolean }): string {
		return `settings.lishNetwork.protected.${i.byInvite ? 'approvedByInvite' : i.renewal ? 'approvedRenewal' : 'approved'}`;
	}
	let daysValid = $derived(Number.isInteger(Number(days)) && Number(days) >= 1 && Number(days) <= 3650);

	async function load(): Promise<void> {
		try {
			requests = await api.overlay.listRequests(network.networkID);
		} catch (e) {
			addNotification(translateError(e), 'error');
		}
	}

	async function run(action: () => Promise<void>): Promise<void> {
		if (busy) return;
		busy = true;
		try {
			await action();
		} catch (e) {
			addNotification(translateError(e), 'error');
		} finally {
			busy = false;
		}
	}

	function addRequest(): Promise<void> {
		return run(async () => {
			let request: unknown;
			try {
				request = JSON.parse(pasted);
			} catch {
				throw new Error($t('settings.lishNetwork.errorInvalidFormat'));
			}
			const added = await api.overlay.importRequest(request as any);
			pasted = '';
			addNotification(tt('settings.lishNetwork.protected.requestAdded', { name: added.name }), 'success');
			await load();
		});
	}

	const navHandle = createNavArea(() => ({ areaID, position, onBack, activate: true }));
	const decidePage = createSubPage(navHandle, () => areaID);

	async function openRequest(request: OverlayPendingRequest): Promise<void> {
		// A member renewing keeps the roles it holds unless they are switched off: an approval without them takes them away.
		// The signed state's hosts tell what it holds now; an older certificate may carry a role taken away since.
		let held: OverlayRole[] = [];
		try {
			const overlay = (await api.lishnets.get(network.networkID))?.overlay;
			if (overlay?.lighthouses.some(h => h.peerID === request.peerID)) held.push('lighthouse');
			if (overlay?.relays.some(h => h.peerID === request.peerID)) held.push('relay');
		} catch (e) {
			addNotification(translateError(e), 'error');
			return;
		}
		selected = request;
		issued = null;
		days = DEFAULT_DAYS;
		heldRoles = held;
		// Roles need the member's public address: a request without one cannot keep them (the switches are hidden then).
		lighthouse = !!request.infraAddr && held.includes('lighthouse');
		relay = !!request.infraAddr && held.includes('relay');
		decidePage.enter(request.name, () => void closeRequest());
	}

	async function closeRequest(): Promise<void> {
		selected = null;
		issued = null;
		await decidePage.exit();
		await load();
	}

	function approve(): Promise<void> {
		return run(async () => {
			if (!selected) return;
			if (!daysValid) throw new Error($t('settings.lishNetwork.protected.validDays'));
			const roles: OverlayRole[] = [...(lighthouse ? (['lighthouse'] as const) : []), ...(relay ? (['relay'] as const) : [])];
			const validUntil = new Date(Date.now() + Number(days) * 86_400_000).toISOString();
			const bundle = await api.overlay.approve(network.networkID, selected.id, { validUntil, roles });
			// A renewal goes back over the lishnet, but a member out of it (switched off, cut off) needs the certificate by hand.
			issued = { name: selected.name, certificate: JSON.stringify(bundle), byInvite: !!selected.invite, renewal: !!selected.renewal };
			addNotification(tt(approvedText(issued), { name: selected.name }), 'success');
		});
	}

	function reject(): Promise<void> {
		return run(async () => {
			if (!selected) return;
			await api.overlay.rejectRequest(network.networkID, selected.id);
			addNotification(tt('settings.lishNetwork.protected.rejected', { name: selected.name }), 'warning');
			await closeRequest();
		});
	}

	const offs: Array<(() => void) | void> = [];
	onMount(() => {
		void load();
		// A request imported by an external service through the API shows up here as well.
		api.subscribe('overlay:request').catch(() => {});
		offs.push(api.on('overlay:request', (data: OverlayPendingRequest) => data?.networkID === network.networkID && void load()));
	});
	onDestroy(() => {
		for (const off of offs) off?.();
		api.unsubscribe('overlay:request').catch(() => {});
	});
</script>

<style>
	.page {
		display: flex;
		flex-direction: column;
		align-items: center;
		height: 100%;
		padding: 2vh;
		gap: 2vh;
		overflow-y: auto;
	}

	.container {
		display: flex;
		flex-direction: column;
		gap: 1.5vh;
		width: 1200px;
		max-width: 100%;
	}

	.mono {
		font-family: var(--font-mono);
		font-size: 1.8vh;
	}

	.detail {
		font-size: 2vh;
		color: var(--primary-foreground);
	}
</style>

{#if decidePage.active && selected}
	<div class="page">
		<div class="container">
			<div class="detail">
				{selected.name} · <span class="mono">{shortenPeerID(selected.peerID)}</span>{#if selected.infraAddr}
					· <span class="mono">{selected.infraAddr}</span>{/if}
			</div>
			{#if issued}
				<Alert type="info" message={tt(approvedText(issued), { name: issued.name })} />
				{#if !issued.byInvite}
					<div role="group" data-mouse-activate-area={areaID}>
						<Input value={issued.certificate} label={tt('settings.lishNetwork.protected.certificateFor', { name: issued.name })} multiline rows={5} readonly fontSize="1.6vh" fontFamily="var(--font-mono)" position={[0, 0]} />
					</div>
				{/if}
				<ButtonBar justify="center" basePosition={[0, 1]}>
					{#if !issued.byInvite}
						<Button icon="/img/copy.svg" label={$t('settings.lishNetwork.protected.copy')} onConfirm={() => copyToClipboard(issued!.certificate, $t('settings.lishNetwork.protected.copied'))} />
					{/if}
					<Button icon="/img/back.svg" label={$t('common.back')} onConfirm={() => void closeRequest()} />
				</ButtonBar>
			{:else}
				<div role="group" data-mouse-activate-area={areaID}>
					<Input bind:value={days} type="number" min={1} max={3650} label={$t('settings.lishNetwork.protected.validDays')} position={[0, 0]} />
				</div>
				{#if heldRoles.length > 0}
					<Alert type={(heldRoles.includes('lighthouse') && !lighthouse) || (heldRoles.includes('relay') && !relay) ? 'warning' : 'info'} message={$t('settings.lishNetwork.protected.rolesKept')} />
				{/if}
				{#if selected.infraAddr}
					<div role="group" data-mouse-activate-area={areaID}>
						<SwitchRow label={$t('settings.lishNetwork.protected.roleLighthouse') + ':'} checked={lighthouse} position={[0, 1]} onToggle={() => (lighthouse = !lighthouse)} />
					</div>
					<div role="group" data-mouse-activate-area={areaID}>
						<SwitchRow label={$t('settings.lishNetwork.protected.roleRelay') + ':'} checked={relay} position={[0, 2]} onToggle={() => (relay = !relay)} />
					</div>
				{:else}
					<Alert type="info" message={$t('settings.lishNetwork.protected.rolesNeedAddress')} />
				{/if}
				<ButtonBar justify="center" basePosition={[0, 3]}>
					<Button icon="/img/check.svg" label={$t('settings.lishNetwork.protected.approve')} disabled={busy || !daysValid} onConfirm={approve} />
					<Button icon="/img/cross.svg" label={$t('settings.lishNetwork.protected.reject')} disabled={busy} onConfirm={reject} />
					<Button icon="/img/back.svg" label={$t('common.back')} onConfirm={() => void closeRequest()} />
				</ButtonBar>
			{/if}
		</div>
	</div>
{:else}
	<div class="page" data-testid="overlay-requests-{network.networkID}">
		<div class="container">
			<div role="group" data-mouse-activate-area={areaID}>
				<Input bind:value={pasted} label={$t('settings.lishNetwork.protected.requestPaste')} multiline rows={4} fontSize="1.6vh" fontFamily="var(--font-mono)" placeholder={'{"type": "lish-overlay-request", ...}'} position={[0, 0]} />
			</div>
			<ButtonBar basePosition={[0, 1]}>
				<Button icon="/img/plus.svg" label={$t('settings.lishNetwork.protected.addRequest')} disabled={busy || !pasted.trim()} onConfirm={addRequest} />
			</ButtonBar>
			{#if requests.length === 0}
				<Alert type="info" message={$t('settings.lishNetwork.protected.noRequests')} />
			{:else}
				<Table columns="1fr 1fr 1fr" columnsMobile="1fr 1fr 1fr">
					<TableHeader>
						<TableCell>{$t('settings.lishNetwork.protected.colName')}</TableCell>
						<TableCell>{$t('settings.lishNetwork.protected.colPeer')}</TableCell>
						<TableCell>{$t('settings.lishNetwork.protected.colOffer')}</TableCell>
					</TableHeader>
					{#each requests as request, i (request.id)}
						<TableRow position={[0, i + 2]} onConfirm={() => void openRequest(request)}>
							<TableCell>{request.name}</TableCell>
							<TableCell><span class="mono">{shortenPeerID(request.peerID)}</span></TableCell>
							<TableCell><span class="mono">{request.infraAddr ?? '—'}</span></TableCell>
						</TableRow>
					{/each}
				</Table>
			{/if}
			<Button icon="/img/back.svg" label={$t('common.back')} position={[0, requests.length + 2]} onConfirm={onBack} />
		</div>
	</div>
{/if}
