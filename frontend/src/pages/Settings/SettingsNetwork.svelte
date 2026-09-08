<script lang="ts">
	import { t } from '../../scripts/language.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import { networkState, networkSubscriptionActive, refreshNetworkState } from '../../scripts/networkState.ts';
	import { primaryInterface, setPrimaryInterface } from '../../scripts/settings.ts';
	import { canOpenNetworkConfig, visiblePrimaryInterface } from '../../scripts/networkConfig.ts';
	import { isSelectableInterface, type NetInterfaceInfo } from '@shared';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import SwitchRow from '../../components/Switch/SwitchRow.svelte';
	import Tabs from '../../components/Tabs/Tabs.svelte';
	import SettingsNetworkEdit from './SettingsNetworkEdit.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		onBack?: (() => void) | undefined;
	}
	let { areaID, position = LAYOUT.content, onBack }: Props = $props();

	// Tunnels, bridges and container veth pairs would flood the picker, so an
	// 'other' interface is only listed when it actually carries traffic.
	let interfaces = $derived($networkState.interfaces.filter(iface => isSelectableInterface(iface) && !(iface.hidden === true && iface.link !== 'up' && !iface.defaultRoute)));
	let medium = $state('wireless');
	let visibleInterfaces = $derived(interfaces.filter(iface => interfaceGroup(iface) === medium).sort((a, b) => Number(b.link === 'up') - Number(a.link === 'up') || a.name.localeCompare(b.name)));
	let tabs = $derived([
		{ id: 'wireless', icon: '/img/wifi.svg', label: `${$t('settings.network.wifi')} (${interfaces.filter(iface => interfaceGroup(iface) === 'wireless').length})` },
		{ id: 'wired', icon: '/img/ethernet.svg', label: `${$t('settings.network.wired')} (${interfaces.filter(iface => interfaceGroup(iface) === 'wired').length})` },
		{ id: 'other', icon: '/img/network.svg', label: `${$t('settings.network.otherAdapters')} (${interfaces.filter(iface => interfaceGroup(iface) === 'other').length})` },
	]);
	let selectedPrimary = $derived(visiblePrimaryInterface($primaryInterface, interfaces));
	// Editing is offered only where the host can actually carry it out, so the app
	// never presents a form whose Save would always fail. `detail` matters as much
	// as the capability: when a platform read fails we fall back to the generic
	// reader, whose ids are device names rather than the identifiers the apply path
	// resolves, so every save from that state would be rejected.
	let editable = $derived($networkState.known && interfaces.some(iface => canOpenNetworkConfig(iface, $networkState.capabilities, $networkState.detail, $networkState.known)));
	let editing = $state<string | null>(null);
	let primaryFailed = $state(false);
	let primaryBusy = $state(false);

	function iconFor(iface: NetInterfaceInfo): string {
		if (iface.virtual) return '/img/network.svg';
		if (iface.medium === 'wired') return '/img/ethernet.svg';
		if (iface.medium === 'wireless') return '/img/wifi.svg';
		return '/img/network.svg';
	}

	function interfaceGroup(iface: NetInterfaceInfo): string {
		return iface.virtual ? 'other' : iface.medium;
	}

	function linkLabel(iface: NetInterfaceInfo): string {
		if (iface.link === 'up') return $t('settings.network.linkUp');
		if (iface.link === 'down') return $t('settings.network.linkDown');
		return $t('settings.network.linkUnknown');
	}

	function modeLabel(iface: NetInterfaceInfo): string {
		if (iface.ipv4Mode === 'dhcp') return $t('settings.network.dhcp');
		if (iface.ipv4Mode === 'static') return $t('settings.network.static');
		return $t('settings.network.modeUnknown');
	}

	// Picking the already-primary interface returns to automatic, so the row works
	// as a toggle and the user is never stuck on a stale manual pick.
	async function pick(id: string): Promise<void> {
		if (primaryBusy) return;
		primaryBusy = true;
		primaryFailed = false;
		try {
			if (!(await setPrimaryInterface(selectedPrimary === id ? '' : id))) {
				primaryFailed = true;
				return;
			}
			try {
				await refreshNetworkState();
			} catch (error) {
				console.error('[NetworkState] Error refreshing primary interface:', error);
			}
		} finally {
			primaryBusy = false;
		}
	}

	createNavArea(() => ({ areaID, position, onBack, activate: true }));
</script>

<style>
	.settings {
		display: flex;
		flex-direction: column;
		align-items: center;
		height: 100%;
		padding: 2vh;
		gap: 1vh;
		overflow-y: auto;
		color: var(--secondary-foreground);
	}

	.container {
		display: flex;
		flex-direction: column;
		gap: 1.2vh;
		width: 960px;
		max-width: 100%;
	}

	.note {
		font-size: clamp(12px, 1.6vh, 15px);
		color: var(--disabled-foreground);
		line-height: 1.45;
	}

	.iface {
		min-width: 0;
	}

	.iface :global(.row) { flex-wrap: nowrap; }
	.iface :global(.button), .settings > :global(.button-bar .button) { transform: none !important; box-shadow: none !important; }
	.footer-choice { margin-top: 1vh; }
	.footer-choice .note { margin-top: 0.8vh; }
	.section-label { margin: 0 0 0.8vh; font-size: clamp(13px, 1.8vh, 17px); font-weight: 600; }

	.detail {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4vh 1.4vh;
		font-size: clamp(12px, 1.55vh, 15px);
		color: var(--disabled-foreground);
		line-height: 1.45;
	}
	.detail span { overflow-wrap: anywhere; }
	.link-up { color: var(--color-success, var(--primary-foreground)); }
	.empty { padding: 3vh 1.5vh; text-align: center; }
	@media (max-width: 620px) {
		.iface :global(.row) { flex-wrap: wrap; }
		.iface :global(.switch-row) { flex-basis: 100%; }
	}
</style>

{#if editing}
	<SettingsNetworkEdit areaID="{areaID}-edit" interfaceID={editing} onBack={() => (editing = null)} />
{:else}
	<div class="settings">
		<div class="container">
			<div role="group" data-mouse-activate-area={areaID}>
				<Tabs {tabs} bind:activeID={medium} position={[0, 0]} />
			</div>
			{#if !$networkState.known && interfaces.length > 0}<div class="note">{$t('settings.network.staleState')}</div>{/if}
			{#if !$networkSubscriptionActive}<div class="note">{$t('settings.network.liveUpdatesUnavailable')}</div>{/if}
			{#if primaryFailed}<div class="note">{$t('settings.network.primarySaveFailed')}</div>{/if}
			{#if $networkState.detail === 'addressesOnly'}
				<div class="note">{$t('settings.network.detailLimited')}</div>
			{/if}
			{#each visibleInterfaces as iface, index (iface.id)}
				<div class="iface">
					<div role="group" data-mouse-activate-area={areaID}>
						<SwitchRow label={iface.name} icon={iconFor(iface)} padding="1.2vh 1.5vh" checked={selectedPrimary === iface.id} position={[0, index + 1]} disabled={primaryBusy} onToggle={() => void pick(iface.id)}>
							{#snippet children()}
								{#if iface.description || iface.virtual}
									<div class="detail">{#if iface.virtual}<span>{$t('settings.network.virtualAdapter')}</span>{/if}{#if iface.description}<span>{iface.description}</span>{/if}</div>
								{/if}
								<div class="detail">
									<span class:link-up={iface.link === 'up'}>{linkLabel(iface)}</span>
									{#if iface.addresses.some(address => address.family === 'ipv4')}<span>{modeLabel(iface)}</span>{/if}
									{#if iface.wifi?.ssid}<span>{iface.wifi.ssid}{iface.wifi.signal !== null ? ` · ${iface.wifi.signal}%` : ''}</span>{/if}
								</div>
								{#if iface.addresses.length || iface.gateway || iface.dns.length}
									<div class="detail">
										{#each iface.addresses as address (address.address)}<span>{address.family === 'ipv4' ? 'IPv4' : 'IPv6'} {address.address}/{address.prefixLength}</span>{/each}
										{#if iface.gateway}<span>{$t('settings.network.gateway')}: {iface.gateway}</span>{/if}
										{#if iface.dns.length}<span>{$t('settings.network.dns')}: {iface.dns.join(', ')}</span>{/if}
									</div>
								{/if}
								{/snippet}
							{#snippet actions()}
								{#if canOpenNetworkConfig(iface, $networkState.capabilities, $networkState.detail, $networkState.known)}
									<Button icon="/img/edit.svg" label={$t('settings.network.configure')} padding="1vh 1.5vh" position={[1, index + 1]} onConfirm={() => (editing = iface.id)} />
								{/if}
							{/snippet}
						</SwitchRow>
					</div>
				</div>
			{:else}
				<!-- Only after a read has settled — before that the list is empty because
			     nothing has been asked yet, not because the host has no interfaces. -->
				{#if $networkState.known}
					<div class="note empty">{$t('settings.network.noAdapters')}</div>
				{/if}
			{/each}
			<div class="footer-choice" role="group" data-mouse-activate-area={areaID}>
				<div class="section-label">{$t('settings.network.footerInterface')}</div>
				<SwitchRow label={$t('settings.network.automatic')} checked={selectedPrimary === ''} position={[0, visibleInterfaces.length + 1]} padding="1vh 1.5vh" disabled={primaryBusy} onToggle={() => void pick('')} />
				<div class="note">{$t('settings.network.primaryHint')}</div>
			</div>
			{#if !editable}<div class="note">{$t('settings.network.readOnlyNote')}</div>{/if}
		</div>
		<ButtonBar justify="center" basePosition={[0, visibleInterfaces.length + 2]}>
			<Button icon="/img/back.svg" label={$t('common.back')} position={[0, visibleInterfaces.length + 2]} onConfirm={onBack} />
		</ButtonBar>
	</div>
{/if}
