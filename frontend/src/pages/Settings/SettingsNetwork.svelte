<script lang="ts">
	import { t } from '../../scripts/language.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import { networkState } from '../../scripts/networkState.ts';
	import { primaryInterface, setPrimaryInterface } from '../../scripts/settings.ts';
	import { isSelectableInterface, type NetInterfaceInfo } from '@shared';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import SwitchRow from '../../components/Switch/SwitchRow.svelte';
	import Icon from '../../components/Icon/Icon.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		onBack?: (() => void) | undefined;
	}
	let { areaID, position = LAYOUT.content, onBack }: Props = $props();

	// Tunnels, bridges and container veth pairs would flood the picker, so an
	// 'other' interface is only listed when it actually carries traffic.
	let interfaces = $derived($networkState.interfaces.filter(isSelectableInterface));

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
	function pick(id: string): void {
		setPrimaryInterface($primaryInterface === id ? '' : id);
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

	.detail {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5vh 2vh;
		padding: 0 1vh 1vh 4vh;
		font-size: 1.8vh;
		color: var(--disabled-foreground);
	}
</style>

<div class="settings">
	<div class="container">
		<div class="note">{$t('settings.network.readOnlyNote')}</div>
		{#if $networkState.detail === 'addressesOnly'}
			<div class="note">{$t('settings.network.detailLimited')}</div>
		{/if}
		<div role="group" data-mouse-activate-area={areaID}>
			<SwitchRow label={$t('settings.network.automatic')} checked={$primaryInterface === ''} position={[0, 0]} onToggle={() => setPrimaryInterface('')} />
		</div>
		{#each interfaces as iface, index (iface.id)}
			<div class="iface">
				<div class="head">
					<Icon img={iconFor(iface)} alt="" size="3vh" padding="0" colorVariable="--primary-foreground" />
					<div role="group" data-mouse-activate-area={areaID} style="flex: 1 1 auto;">
						<SwitchRow label="{iface.name} — {linkLabel(iface)}" checked={$primaryInterface === iface.id} position={[0, index + 1]} onToggle={() => pick(iface.id)} />
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
