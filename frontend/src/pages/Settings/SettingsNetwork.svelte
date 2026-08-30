<script lang="ts">
	import { t } from '../../scripts/language.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import { networkState, refreshNetworkState } from '../../scripts/networkState.ts';
	import { primaryInterface, setPrimaryInterface } from '../../scripts/settings.ts';
	import { canOpenNetworkConfig, visiblePrimaryInterface } from '../../scripts/networkConfig.ts';
	import { isSelectableInterface, type NetInterfaceInfo } from '@shared';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import SwitchRow from '../../components/Switch/SwitchRow.svelte';
	import Icon from '../../components/Icon/Icon.svelte';
	import SettingsNetworkEdit from './SettingsNetworkEdit.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		onBack?: (() => void) | undefined;
	}
	let { areaID, position = LAYOUT.content, onBack }: Props = $props();

	// Tunnels, bridges and container veth pairs would flood the picker, so an
	// 'other' interface is only listed when it actually carries traffic.
	let interfaces = $derived($networkState.interfaces.filter(isSelectableInterface));
	let selectedPrimary = $derived(visiblePrimaryInterface($primaryInterface, interfaces));
	// Editing is offered only where the host can actually carry it out, so the app
	// never presents a form whose Save would always fail. `detail` matters as much
	// as the capability: when a platform read fails we fall back to the generic
	// reader, whose ids are device names rather than the identifiers the apply path
	// resolves, so every save from that state would be rejected.
	let editable = $derived(($networkState.capabilities.ipv4 || $networkState.capabilities.wifi) && $networkState.detail === 'full');
	let editing = $state<string | null>(null);
	let primaryFailed = $state(false);
	let primaryBusy = $state(false);

	function iconFor(iface: NetInterfaceInfo): string {
		if (iface.medium === 'wired') return '/img/ethernet.svg';
		if (iface.medium === 'wireless') return '/img/wifi.svg';
		return '/img/network.svg';
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
	}

	.container {
		display: flex;
		flex-direction: column;
		gap: 1vh;
		width: 1000px;
		max-width: 100%;
	}

	.note {
		font-size: 1.8vh;
		color: var(--disabled-foreground);
	}

	.iface {
		display: flex;
		flex-direction: column;
		gap: 0.5vh;
	}

	.head {
		display: flex;
		align-items: center;
		gap: 1vh;
	}

	.head :global(.icon) {
		flex: 0 0 auto;
	}

	.configure {
		padding: 0 0 1vh 4vh;
	}

	.detail {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5vh 2vh;
		padding: 0 1vh 1vh 4vh;
		font-size: 1.8vh;
		color: var(--disabled-foreground);
	}
</style>

{#if editing}
	<SettingsNetworkEdit areaID="{areaID}-edit" interfaceID={editing} onBack={() => (editing = null)} />
{:else}
	<div class="settings">
		<div class="container">
			<div class="note">{editable ? $t('settings.network.editableNote') : $t('settings.network.readOnlyNote')}</div>
			{#if primaryFailed}<div class="note">{$t('settings.network.primarySaveFailed')}</div>{/if}
			{#if $networkState.detail === 'addressesOnly'}
				<div class="note">{$t('settings.network.detailLimited')}</div>
			{/if}
			<div role="group" data-mouse-activate-area={areaID}>
				<SwitchRow label={$t('settings.network.automatic')} checked={selectedPrimary === ''} position={[0, 0]} disabled={primaryBusy} onToggle={() => void pick('')} />
			</div>
			{#each interfaces as iface, index (iface.id)}
				<div class="iface">
					<div class="head">
						<Icon img={iconFor(iface)} alt="" size="3vh" padding="0" colorVariable="--primary-foreground" />
						<div role="group" data-mouse-activate-area={areaID} style="flex: 1 1 auto;">
							<SwitchRow label="{iface.name} — {linkLabel(iface)}" checked={selectedPrimary === iface.id} position={[0, index + 1]} disabled={primaryBusy} onToggle={() => void pick(iface.id)} />
						</div>
					</div>
					<div class="detail">
						<span>{modeLabel(iface)}</span>
						{#each iface.addresses as address (address.address)}
							<span>{address.address}/{address.prefixLength}</span>
						{/each}
						{#if iface.gateway}<span>{$t('settings.network.gateway')}: {iface.gateway}</span>{/if}
						{#if iface.dns.length > 0}<span>{$t('settings.network.dns')}: {iface.dns.join(', ')}</span>{/if}
						{#if iface.wifi}
							<span>{$t('settings.network.ssid')}: {iface.wifi.ssid ?? '—'}</span>
							<span>{$t('settings.network.signal')}: {iface.wifi.signal !== null ? `${iface.wifi.signal}%` : '—'}</span>
						{/if}
					</div>
					{#if canOpenNetworkConfig(iface, $networkState.capabilities, $networkState.detail)}
						<div role="group" data-mouse-activate-area={areaID} class="configure">
							<Button icon="/img/edit.svg" label={$t('settings.network.configure')} position={[1, index + 1]} onConfirm={() => (editing = iface.id)} />
						</div>
					{/if}
				</div>
			{:else}
				<!-- Only after a read has settled — before that the list is empty because
			     nothing has been asked yet, not because the host has no interfaces. -->
				{#if $networkState.known}
					<div class="note">{$t('settings.network.noInterfaces')}</div>
				{/if}
			{/each}
		</div>
		<ButtonBar justify="center" basePosition={[0, interfaces.length + 1]}>
			<Button icon="/img/back.svg" label={$t('common.back')} onConfirm={onBack} />
		</ButtonBar>
	</div>
{/if}
