<script lang="ts">
	import { t } from '../../scripts/language.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import { canEditInterfaceIPv4, canEditInterfaceWifi, networkState } from '../../scripts/networkState.ts';
	import { primaryInterface, setPrimaryInterface } from '../../scripts/settings.ts';
	import { isSelectableInterface, type NetInterfaceInfo } from '@shared';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import SwitchRow from '../../components/Switch/SwitchRow.svelte';
	import Icon from '../../components/Icon/Icon.svelte';
	import Dot from '../../components/Dot/Dot.svelte';
	import Table from '../../components/Table/Table.svelte';
	import TableHeader from '../../components/Table/TableHeader.svelte';
	import TableRow from '../../components/Table/TableRow.svelte';
	import TableCell from '../../components/Table/TableCell.svelte';
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
	// Editing is offered only where the host can actually carry it out, so the app
	// never presents a form whose Save would always fail. `detail` matters as much
	// as the capability: when a platform read fails we fall back to the generic
	// reader, whose ids are device names rather than the identifiers the apply path
	// resolves, so every save from that state would be rejected.
	//
	// The two capabilities are independent — Windows lets any user join a Wi-Fi
	// network but only an elevated one change an address — so an interface is
	// configurable when EITHER applies to it. Wi-Fi alone opens the screen for an
	// interface with a radio only, since that is all there would be to do on it:
	// `wifi` is present exactly when the platform reader found a real radio behind
	// the interface, which is what keeps out the Wi-Fi Direct virtual adapters that
	// call themselves wireless and cannot scan.
	let canEditIPv4 = $derived($networkState.capabilities.ipv4 && $networkState.detail === 'full');
	// The same two rules the editor itself applies, so the list cannot offer a
	// Configure button the next screen would then have to refuse.
	function isConfigurable(iface: NetInterfaceInfo): boolean {
		return canEditInterfaceIPv4(iface, $networkState) || canEditInterfaceWifi(iface, $networkState);
	}
	let editing = $state<string | null>(null);

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

	function linkDot(iface: NetInterfaceInfo): 'success' | 'error' | 'disabled' {
		if (iface.link === 'up') return 'success';
		if (iface.link === 'down') return 'error';
		return 'disabled';
	}

	/** The addresses worth showing in one line: IPv4 first, since that is what the form edits. */
	function addressList(iface: NetInterfaceInfo): string[] {
		const ipv4 = iface.addresses.filter(a => a.family === 'ipv4');
		const rest = iface.addresses.filter(a => a.family !== 'ipv4');
		return [...ipv4, ...rest].map(a => `${a.address}/${a.prefixLength}`);
	}

	/**
	 * The second line of the address cell: how the address was obtained, how many
	 * more there are, and the gateway. Empty when the first line already says all
	 * there is to say, so an interface holding nothing stays one line tall — most
	 * of the list is virtual adapters with no address at all.
	 */
	function addressDetail(iface: NetInterfaceInfo): string {
		const addresses = addressList(iface);
		if (addresses.length === 0) return '';
		const parts = [modeLabel(iface)];
		if (addresses.length > 1) parts.push(`+${addresses.length - 1}`);
		if (iface.gateway) parts.push(`${$t('settings.network.gateway')} ${iface.gateway}`);
		return parts.join(' · ');
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

	.name {
		display: flex;
		align-items: center;
		gap: 1vh;
		min-width: 0;
	}

	/* Two lines in one cell: the identifying value, and the detail it needs to be
	   read with. Keeps a row one line tall while the list stays scannable. */
	.label {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.label,
	.state {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.sub {
		font-size: 1.4vh;
		color: var(--disabled-foreground);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.state {
		display: inline-flex;
		align-items: center;
		gap: 0.8vh;
	}
</style>

{#if editing}
	<SettingsNetworkEdit areaID="{areaID}-edit" interfaceID={editing} onBack={() => (editing = null)} />
{:else}
	<div class="settings">
		<div class="container">
			<!-- The note is about ADDRESSING specifically, so it follows the addressing
			     capability alone — a host that can only join Wi-Fi networks still shows
			     its addresses read-only, and saying otherwise would be a promise the
			     Save button could not keep. -->
			<div class="note">{canEditIPv4 ? $t('settings.network.editableNote') : $t('settings.network.readOnlyNote')}</div>
			{#if $networkState.detail === 'addressesOnly'}
				<div class="note">{$t('settings.network.detailLimited')}</div>
			{/if}
			<div role="group" data-mouse-activate-area={areaID}>
				<SwitchRow label={$t('settings.network.automatic')} checked={$primaryInterface === ''} position={[0, 0]} onToggle={() => setPrimaryInterface('')} />
			</div>
			{#if interfaces.length > 0}
				<Table columns="1.7fr 1fr 1.8fr auto" columnsMobile="1.4fr auto 1.2fr auto" gap="1.5vh">
					<TableHeader>
						<TableCell>{$t('common.name')}</TableCell>
						<TableCell align="center">{$t('common.status')}</TableCell>
						<TableCell>{$t('settings.network.address')}</TableCell>
						<TableCell align="center">{''}</TableCell>
					</TableHeader>
					<div role="group" data-mouse-activate-area={areaID}>
						{#each interfaces as iface, index (iface.id)}
							{@const isPrimary = $primaryInterface === iface.id}
							<!-- The row highlight belongs to the keyboard cursor (TableRow ignores
							     `selected` once it has a position), so the chosen interface is marked
							     in the cell instead of by the row's own colour. -->
							<TableRow position={[0, index + 1]} onConfirm={() => pick(iface.id)}>
								<TableCell>
									<span class="name">
										<Icon img={isPrimary ? '/img/check.svg' : iconFor(iface)} alt="" size="2.2vh" padding="0" colorVariable={isPrimary ? '--success-foreground' : '--primary-foreground'} />
										<span class="label">
											{iface.name}
											{#if iface.wifi?.ssid}<span class="sub"
													>{iface.wifi.ssid}{#if iface.wifi.signal !== null && iface.wifi.signal !== undefined}&nbsp;·&nbsp;{iface.wifi.signal}%{/if}</span
												>{/if}
										</span>
									</span>
								</TableCell>
								<TableCell align="center"><span class="state"><Dot status={linkDot(iface)} size="1vh" />{linkLabel(iface)}</span></TableCell>
								<TableCell>
									<span class="label">
										{addressList(iface)[0] ?? modeLabel(iface)}
										{#if addressDetail(iface)}<span class="sub">{addressDetail(iface)}</span>{/if}
									</span>
								</TableCell>
								<TableCell align="center">
									{#if isConfigurable(iface)}
										<Button icon="/img/edit.svg" label={$t('settings.network.configure')} position={[1, index + 1]} onConfirm={() => (editing = iface.id)} />
									{/if}
								</TableCell>
							</TableRow>
						{/each}
					</div>
				</Table>
			{:else if $networkState.known}
				<!-- Only after a read has settled — before that the list is empty because
				     nothing has been asked yet, not because the host has no interfaces. -->
				<div class="note">{$t('settings.network.noInterfaces')}</div>
			{/if}
		</div>
		<ButtonBar justify="center" basePosition={[0, interfaces.length + 1]}>
			<Button icon="/img/back.svg" label={$t('common.back')} onConfirm={onBack} />
		</ButtonBar>
	</div>
{/if}
