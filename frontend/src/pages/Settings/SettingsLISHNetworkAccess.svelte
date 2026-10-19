<script lang="ts">
	import { onDestroy, onMount, untrack } from 'svelte';
	import { t, translateError, tt } from '../../scripts/language.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import { createSubPage } from '../../scripts/subPage.svelte.ts';
	import { addNotification } from '../../scripts/notifications.ts';
	import { copyToClipboard } from '../../scripts/clipboard.ts';
	import { api } from '../../scripts/api.ts';
	import { isHostPort, MEMBER_RENEWAL_WINDOW_MS, type LISHNetworkConfig, type OverlayStatus } from '@shared';
	import Alert from '../../components/Alert/Alert.svelte';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import Icon from '../../components/Icon/Icon.svelte';
	import Input from '../../components/Input/Input.svelte';
	import Table from '../../components/Table/Table.svelte';
	import TableRow from '../../components/Table/TableRow.svelte';
	import TableCell from '../../components/Table/TableCell.svelte';
	import LISHNetworkAccessRequests from './SettingsLISHNetworkAccessRequests.svelte';
	import LISHNetworkAccessMembers from './SettingsLISHNetworkAccessMembers.svelte';
	import LISHNetworkAccessKey from './SettingsLISHNetworkAccessKey.svelte';
	import LISHNetworkInvite from './SettingsLISHNetworkInvite.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		network: LISHNetworkConfig;
		onBack?: (() => void) | undefined;
	}
	let { areaID, position = LAYOUT.content, network, onBack }: Props = $props();
	const EVENTS = ['overlay:status', 'overlay:state', 'overlay:members'];

	let status = $state<OverlayStatus | null>(null);
	let error = $state('');
	let busy = $state(false);
	let name = $state('');
	let infraAddr = $state('');
	let certificate = $state('');
	let inviteText = $state('');
	let founder = $derived(status?.role === 'founder');
	let requestJSON = $derived(status?.request ? JSON.stringify(status.request) : '');
	let relayed = $derived(status?.peers.filter(p => p.path === 'relay').length ?? 0);
	let direct = $derived(status?.peers.filter(p => p.path === 'direct').length ?? 0);
	let expired = $derived(!!status?.certificate && Date.parse(status.certificate.notAfter) <= Date.now());
	/** A member still in the lishnet hands its renewal in over it, and gets the certificate back the same way. */
	let inLishnet = $derived(!!status?.certificate && !status.certificate.revoked && !expired && !!status.running);
	let renewingOnline = $derived(!!status?.request && inLishnet && !status.invite && !status.renewalRefused);
	let endingSoon = $derived(!!status?.certificate && !expired && Date.parse(status.certificate.notAfter) - Date.now() <= MEMBER_RENEWAL_WINDOW_MS);
	/** A member out of the lishnet (revoked or expired), or about to be, asks again the same way as the first time. */
	let canRequest = $derived(!!status && (!status.request || !!status.renewalRefused) && (status.role === 'none' || (!founder && (!!status.certificate?.revoked || expired || endingSoon))));
	/** Out of the lishnet, a new invite from the founder is the simple way back in. */
	let canRejoin = $derived(!!status && !founder && !status.invite && (status.role === 'none' || !!status.certificate?.revoked || expired));
	// A renewal asks as the last request did.
	$effect(() => {
		const last = status?.request ?? status?.lastRequest;
		if (!last) return;
		untrack(() => {
			if (!name) name = last.name;
			if (!infraAddr && last.infraAddr) infraAddr = last.infraAddr;
		});
	});
	/** Running is not enough: without a lighthouse or relay reachable the node is cut off. */
	let online = $derived(!!status?.running && status.hosts.some(h => h.connected));

	async function load(): Promise<void> {
		try {
			status = await api.overlay.status(network.networkID);
			error = '';
		} catch (e) {
			error = translateError(e);
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

	function requestAccess(): Promise<void> {
		return run(async () => {
			if (!name.trim()) throw new Error($t('settings.lishNetwork.errorNameRequired'));
			if (infraAddr.trim() && !isHostPort(infraAddr.trim())) throw new Error($t('settings.lishNetwork.protected.addrInvalid'));
			await api.overlay.requestAccess(network.networkID, name.trim(), infraAddr.trim() || undefined);
			// A member in the lishnet hands it in by itself; only one outside has to send it.
			addNotification($t(`settings.lishNetwork.protected.${inLishnet ? 'renewalRequested' : 'requestCreated'}`), 'success');
			await load();
		});
	}

	function importCertificate(): Promise<void> {
		return run(async () => {
			let bundle: unknown;
			try {
				bundle = JSON.parse(certificate);
			} catch {
				throw new Error($t('settings.lishNetwork.protected.errorCertificateInvalid'));
			}
			status = await api.overlay.importCertificate(bundle as any);
			certificate = '';
			addNotification($t('settings.lishNetwork.protected.certificateImported'), 'success');
		});
	}

	function createInvite(): Promise<void> {
		return run(async () => {
			inviteText = (await api.overlay.createInvite(network.networkID)).invite;
		});
	}

	function onEvent(data: { networkID?: string }): void {
		if (!data?.networkID || data.networkID === network.networkID) void load();
	}

	const navHandle = createNavArea(() => ({ areaID, position, onBack, activate: true }));
	const requestsPage = createSubPage(navHandle, () => areaID);
	const membersPage = createSubPage(navHandle, () => areaID);
	const keyPage = createSubPage(navHandle, () => areaID);
	const invitePage = createSubPage(navHandle, () => areaID);
	const offs: Array<(() => void) | void> = [];
	onMount(() => {
		void load();
		api.subscribe(...EVENTS).catch(() => {});
		for (const event of EVENTS) offs.push(api.on(event, onEvent));
		// Tunnels come and go without an event of their own; the status is cheap to ask for.
		const timer = setInterval(() => void load(), 5000);
		return () => clearInterval(timer);
	});
	onDestroy(() => {
		for (const off of offs) off?.();
		api.unsubscribe(...EVENTS).catch(() => {});
	});

	function formatDate(iso: string): string {
		return new Date(iso).toLocaleString();
	}
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

	.label {
		font-size: 2vh;
		color: var(--disabled-foreground);
	}

	.value {
		font-size: 2vh;
		color: var(--primary-foreground);
		word-break: break-all;
	}

	.mono {
		font-family: var(--font-mono);
	}

	.host {
		display: flex;
		align-items: center;
		gap: 1vh;
	}
</style>

{#if requestsPage.active}
	<LISHNetworkAccessRequests {areaID} {position} {network} onBack={() => void requestsPage.exit()} />
{:else if membersPage.active}
	<LISHNetworkAccessMembers {areaID} {position} {network} onBack={() => void membersPage.exit()} />
{:else if keyPage.active}
	<LISHNetworkAccessKey {areaID} {position} {network} onBack={() => void keyPage.exit()} />
{:else if invitePage.active}
	<LISHNetworkInvite
		{areaID}
		{position}
		defaultName={name}
		onBack={() => void invitePage.exit()}
		onJoined={joined => {
			status = joined;
			void invitePage.exit();
		}}
	/>
{:else}
	<div class="page" data-testid="overlay-access-{network.networkID}">
		<div class="container">
			<ButtonBar basePosition={[0, 0]}>
				<Button icon="/img/back.svg" label={$t('common.back')} onConfirm={onBack} padding="1vh 1.5vh" fontSize="1.6vh" />
				{#if founder}
					<Button icon="/img/link.svg" label={$t('settings.lishNetwork.protected.invite')} disabled={busy} onConfirm={createInvite} padding="1vh 1.5vh" fontSize="1.6vh" />
					<Button icon="/img/plus.svg" label={$t('settings.lishNetwork.protected.requests')} onConfirm={() => requestsPage.enter(`${network.name} - ${$t('settings.lishNetwork.protected.requests')}`)} padding="1vh 1.5vh" fontSize="1.6vh" />
					<Button icon="/img/person.svg" label={$t('settings.lishNetwork.protected.members')} onConfirm={() => membersPage.enter(`${network.name} - ${$t('settings.lishNetwork.protected.members')}`)} padding="1vh 1.5vh" fontSize="1.6vh" />
				{/if}
				{#if canRejoin}
					<Button icon="/img/link.svg" label={$t('settings.lishNetwork.protected.joinByInvite')} onConfirm={() => invitePage.enter(`${network.name} - ${$t('settings.lishNetwork.protected.joinByInvite')}`)} padding="1vh 1.5vh" fontSize="1.6vh" />
				{/if}
				<Button icon="/img/key.svg" label={founder ? $t('settings.lishNetwork.protected.backupCA') : $t('settings.lishNetwork.protected.restoreCA')} onConfirm={() => keyPage.enter(`${network.name} - ${$t('settings.lishNetwork.protected.caKey')}`)} padding="1vh 1.5vh" fontSize="1.6vh" />
			</ButtonBar>
			{#if error}
				<Alert type="error" message={error} />
			{/if}
			{#if inviteText}
				<div role="group" data-mouse-activate-area={areaID}>
					<Input value={inviteText} label={$t('settings.lishNetwork.protected.inviteText')} multiline rows={3} readonly fontSize="1.6vh" fontFamily="var(--font-mono)" position={[0, 1]} />
				</div>
				<ButtonBar basePosition={[0, 2]}>
					<Button icon="/img/copy.svg" label={$t('settings.lishNetwork.protected.copy')} onConfirm={() => copyToClipboard(inviteText, $t('settings.lishNetwork.protected.copied'))} />
				</ButtonBar>
			{/if}
			{#if status}
				{#if status.invite}
					{#if status.invite.state === 'expired'}
						<Alert type="error" message={tt('settings.lishNetwork.protected.inviteExpired', { date: formatDate(status.invite.expires) })} />
					{:else if status.invite.state === 'refused'}
						<Alert type="error" message={$t('settings.lishNetwork.protected.inviteRefused')} />
					{:else}
						<Alert type="info" message={$t(`settings.lishNetwork.protected.${status.invite.state === 'pending' ? 'invitePending' : 'inviteDelivering'}`)} />
					{/if}
				{/if}
				{#if status.renewalRefused}
					<Alert type="error" message={$t('settings.lishNetwork.protected.renewalRefused')} />
				{/if}
				{#if status.certificate?.revoked}
					<Alert type="error" message={$t('settings.lishNetwork.protected.revoked')} />
				{:else if expired && status.certificate}
					<Alert type="error" message={tt('settings.lishNetwork.protected.expired', { date: formatDate(status.certificate.notAfter) })} />
				{:else if endingSoon && status.certificate && !founder}
					<Alert type="warning" message={tt('settings.lishNetwork.protected.endingSoon', { date: formatDate(status.certificate.notAfter) })} />
				{:else if status.certificate && !founder}
					<Alert type="info" message={tt('settings.lishNetwork.protected.accessUntil', { date: formatDate(status.certificate.notAfter) })} />
				{/if}
				<Table columns="35vh 1fr" noBorder>
					<TableRow>
						<TableCell><span class="label">{$t('settings.lishNetwork.protected.role')}</span></TableCell>
						<TableCell><span class="value" data-testid="overlay-role">{$t(`settings.lishNetwork.protected.role${status.role === 'founder' ? 'Founder' : status.role === 'member' ? 'Member' : 'None'}`)}</span></TableCell>
					</TableRow>
					{#if status.certificate}
						<TableRow>
							<TableCell><span class="label">{$t('settings.lishNetwork.protected.address')}</span></TableCell>
							<TableCell><span class="value mono">{status.certificate.vpnIP}</span></TableCell>
						</TableRow>
						<TableRow>
							<!-- Both ends: a wrong clock on this computer shows as a validity that has not started or already ended. -->
							<TableCell><span class="label">{$t('settings.lishNetwork.protected.validity')}</span></TableCell>
							<TableCell><span class="value">{formatDate(status.certificate.notBefore)} – {formatDate(status.certificate.notAfter)}</span></TableCell>
						</TableRow>
						<TableRow>
							<TableCell><span class="label">{$t('settings.lishNetwork.protected.connection')}</span></TableCell>
							<TableCell><span class="value">{online ? $t('settings.lishNetwork.protected.running') : $t('settings.lishNetwork.protected.notRunning')} · {tt('settings.lishNetwork.protected.peers', { relay: String(relayed), direct: String(direct) })}</span></TableCell>
						</TableRow>
					{/if}
					<TableRow>
						<TableCell><span class="label">{$t('settings.lishNetwork.protected.hosts')}</span></TableCell>
						<TableCell>
							{#if status.hosts.length === 0}
								<span class="value">{$t('settings.lishNetwork.protected.noHosts')}</span>
							{/if}
							{#each status.hosts as host (host.role + host.vpnIP)}
								<div class="host">
									<Icon img={host.connected ? '/img/check.svg' : '/img/cross.svg'} size="2vh" padding="0" colorVariable={host.connected ? '--color-success' : '--secondary-foreground'} alt={host.connected ? $t('settings.lishNetwork.protected.hostConnected') : $t('settings.lishNetwork.protected.hostDisconnected')} />
									<span class="value">{$t(`settings.lishNetwork.protected.${host.role}`)}: <span class="mono">{host.addr}</span> ({host.vpnIP}){host.self ? ` · ${$t('settings.lishNetwork.protected.self')}` : ''}</span>
								</div>
							{/each}
						</TableCell>
					</TableRow>
				</Table>
				{#if canRequest}
					<div role="group" data-mouse-activate-area={areaID}>
						<Input bind:value={name} label={$t('settings.lishNetwork.protected.yourName')} position={[0, 1]} />
					</div>
					<div role="group" data-mouse-activate-area={areaID}>
						<Input bind:value={infraAddr} label={$t('settings.lishNetwork.protected.infraAddr')} placeholder="203.0.113.7:4242" position={[0, 2]} />
					</div>
					<ButtonBar basePosition={[0, 3]}>
						<Button icon="/img/key.svg" label={$t(`settings.lishNetwork.protected.${status.certificate && !founder ? 'requestRenewal' : 'requestAccess'}`)} disabled={busy} onConfirm={requestAccess} />
					</ButtonBar>
				{:else if !founder}
					<!-- An invite or a running member carries the request and the certificate by itself; the JSON is for passing them by hand. -->
					{#if renewingOnline}
						<Alert type="info" message={$t('settings.lishNetwork.protected.renewalPending')} />
					{:else if requestJSON && !status.invite}
						<div role="group" data-mouse-activate-area={areaID}>
							<Input value={requestJSON} label={$t('settings.lishNetwork.protected.requestText')} multiline rows={4} readonly fontSize="1.6vh" fontFamily="var(--font-mono)" position={[0, 1]} />
						</div>
						<ButtonBar basePosition={[0, 2]}>
							<Button icon="/img/copy.svg" label={$t('settings.lishNetwork.protected.copy')} onConfirm={() => copyToClipboard(requestJSON, $t('settings.lishNetwork.protected.copied'))} />
						</ButtonBar>
						<div role="group" data-mouse-activate-area={areaID}>
							<Input bind:value={certificate} label={$t('settings.lishNetwork.protected.certificateText')} multiline rows={4} fontSize="1.6vh" fontFamily="var(--font-mono)" placeholder={'{"type": "lish-overlay-certificate", ...}'} position={[0, 3]} />
						</div>
						<ButtonBar basePosition={[0, 4]}>
							<Button icon="/img/import.svg" label={$t('settings.lishNetwork.protected.importCertificate')} disabled={busy || !certificate.trim()} onConfirm={importCertificate} />
						</ButtonBar>
					{/if}
				{/if}
			{/if}
		</div>
	</div>
{/if}
