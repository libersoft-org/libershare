<script lang="ts">
	import { t, translateError } from '../../scripts/language.ts';
	import { get } from 'svelte/store';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import { applyInterfaceConfig, disconnectWifiNetwork, joinWifiNetwork, networkState, refreshNetworkState, scanWifiNetworks } from '../../scripts/networkState.ts';
	import { networkConfigFormFrom, networkConfigFromForm, networkFormMessage, networkFormUpdate, validateNetworkConfigForm, type DnsUpdateMode, type NetworkConfigForm } from '../../scripts/networkConfig.ts';
	import { ipv4BaselineOf, isUnambiguousWifiTarget, type NetAddressMode, type NetInterfaceInfo, type NetIPv4Baseline, type NetIPv4Config, type NetWifiNetwork, type NetworkStateInfo } from '@shared';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import Icon from '../../components/Icon/Icon.svelte';
	import Input from '../../components/Input/Input.svelte';
	import Select from '../../components/Input/Select.svelte';
	import SelectOption from '../../components/Input/SelectOption.svelte';
	interface Props {
		areaID: string;
		interfaceID: string;
		position?: Position | undefined;
		onBack?: (() => void) | undefined;
	}
	let { areaID, interfaceID, position = LAYOUT.content, onBack }: Props = $props();

	let iface = $derived($networkState.interfaces.find(i => i.id === interfaceID));
	let canEditIPv4 = $derived($networkState.known && $networkState.detail === 'full' && !!iface && iface.ipv4Configurable && $networkState.capabilities.ipv4);
	let canEditWifi = $derived($networkState.known && $networkState.detail === 'full' && !!iface && iface.wifiConfigurable && $networkState.capabilities.wifi);

	let mode = $state<NetAddressMode>('unknown');
	let address = $state('');
	let prefix = $state('24');
	let gateway = $state('');
	let dnsMode = $state<DnsUpdateMode>('unchanged');
	let dns = $state('');
	let busy = $state(false);
	let joiningSSID = $state<string | null>(null);
	let disconnecting = $state(false);
	let disconnectFeedback = $state(false);
	let wifiFeedback = $state<NetWifiNetwork | null>(null);
	let message = $state('');
	let failed = $state(false);
	let networks = $state<NetWifiNetwork[]>([]);
	let scanning = $state(false);
	let selection = $state<NetWifiNetwork | null>(null);
	let password = $state('');
	let selectedNetwork = $derived(networks.find(network => selection && sameNetwork(network, selection)));

	// Seed the form from the live state when the screen opens, then keep it in
	// step with the host only while the user has not started editing. Re-seeding
	// over typed input would throw the user's work away; saving typed input over a
	// configuration that changed underneath would throw the host's change away,
	// so that case blocks Save until the user reloads the form.
	let baseline = $state<NetIPv4Baseline | null>(null);
	let seededForm: NetworkConfigForm | null = null;
	let stale = $state(false);
	// Automatic host updates preserve an operation's result until the next user edit or operation.
	let reported = $state(false);
	$effect(() => {
		if (!iface || busy) return;
		const update = networkFormUpdate(ipv4BaselineOf(iface), baseline, formDirty());
		const announcement = networkFormMessage(update, reported);
		if (announcement === 'keep') return;
		if (announcement === 'stale' || announcement === 'staleSilent') {
			stale = true;
			// Blocking Save and offering the reload button is the whole state; the
			// wording is only added when there is nothing more useful on screen.
			if (announcement === 'stale') {
				failed = true;
				message = $t('settings.network.changedOutside');
				reported = false;
			}
			return;
		}
		seedFrom(iface);
		if (announcement === 'reseedAnnounce') {
			failed = false;
			message = $t('settings.network.reloadedFromHost');
		}
	});

	function seedFrom(source: NetInterfaceInfo): void {
		const form = networkConfigFormFrom(source);
		mode = form.mode;
		address = form.address;
		prefix = form.prefix;
		gateway = form.gateway;
		dnsMode = form.dnsMode;
		dns = form.dns;
		seededForm = form;
		baseline = ipv4BaselineOf(source);
		stale = false;
	}

	function currentForm(): NetworkConfigForm {
		return { mode, address, prefix, gateway, dnsMode, dns };
	}

	function formDirty(): boolean {
		return JSON.stringify(currentForm()) !== JSON.stringify(seededForm);
	}

	function clearMessage(): void {
		disconnectFeedback = false;
		wifiFeedback = null;
		reported = false;
		failed = stale;
		message = stale ? $t('settings.network.changedOutside') : '';
	}

	function reloadForm(): void {
		disconnectFeedback = false;
		wifiFeedback = null;
		if (iface) seedFrom(iface);
		failed = false;
		message = '';
		// The message this protected is gone, so the protection goes with it.
		reported = false;
	}

	function seedCurrentInterface(): void {
		const current = get(networkState).interfaces.find(item => item.id === interfaceID);
		if (current) seedFrom(current);
	}

	/**
	 * Publish what the host looks like after a Wi-Fi join, and leave the addressing
	 * form to the rule every other update goes through.
	 *
	 * A successful join already stored the state it returned. A failed one has to
	 * be read back, because the attempt may still have moved the interface. Neither
	 * re-seeds the form here: the join changes the interface the form is open on,
	 * which is exactly the case the effect above decides — keep what the user typed,
	 * mark it stale when the host moved under it, re-seed only a clean form.
	 * Re-seeding unconditionally threw away a half-typed address, gateway or DNS
	 * and cleared the stale flag with it.
	 */
	async function syncAfterWifiMutation(state?: NetworkStateInfo): Promise<void> {
		if (state) return;
		try {
			await refreshNetworkState();
		} catch {}
	}

	async function refreshWifiNetworks(): Promise<void> {
		scanning = true;
		try {
			networks = await scanWifiNetworks(interfaceID);
		} catch {
			networks = [];
		} finally {
			scanning = false;
		}
	}

	async function save(): Promise<void> {
		if (busy || scanning || stale || !baseline) return;
		const expected = baseline;
		const form = currentForm();
		const invalid = validateNetworkConfigForm(form, $networkState.capabilities);
		if (invalid) {
			failed = true;
			message = invalid === 'mode' ? $t('settings.network.modeUnknown') : $t('settings.network.invalidField', { field: $t('settings.network.field.' + invalid) });
			return;
		}
		const config = networkConfigFromForm(form) as NetIPv4Config;
		disconnectFeedback = false;
		wifiFeedback = null;
		busy = true;
		message = '';
		reported = false;
		try {
			await applyInterfaceConfig(interfaceID, config, expected);
			seedCurrentInterface();
			failed = false;
			message = $t('settings.network.applied');
			reported = true;
		} catch (error) {
			failed = true;
			message = translateError(error);
			reported = true;
			try {
				const current = (await refreshNetworkState()).interfaces.find(item => item.id === interfaceID);
				// A stale form is reloaded so the user sees what they would now be
				// editing over. Any other failure keeps the typed values for a retry and
				// leaves the baseline where it was: if the host moved anyway, whether
				// the failed attempt moved it or somebody else did, the form goes stale
				// and Save stays blocked until the user reloads it. Adopting the new
				// state here instead would let the retry overwrite that change without
				// ever saying so.
				if (current && (error as { code?: string }).code === 'NETCONFIG_STALE') seedFrom(current);
			} catch {}
		} finally {
			busy = false;
		}
	}

	async function scan(): Promise<void> {
		if (scanning || busy) return;
		scanning = true;
		clearMessage();
		try {
			networks = await scanWifiNetworks(interfaceID);
			if (networks.length === 0) {
				failed = false;
				message = $t('settings.network.noWifiFound');
				reported = true;
			}
		} catch (error) {
			failed = true;
			message = translateError(error);
			reported = true;
		} finally {
			scanning = false;
		}
	}

	function selectNetwork(network: NetWifiNetwork): void {
		if (!joinable(network)) return;
		clearMessage();
		// An open network takes no key, and asking for one would invite the user to
		// type a password that cannot be used.
		password = '';
		if (!network.secured) {
			selection = null;
			void join(network);
			return;
		}
		selection = { ...network };
	}

	async function join(network?: NetWifiNetwork): Promise<void> {
		const target = network ?? selectedNetwork;
		if (!target || !joinable(target) || busy || scanning) return;
		const { ssid, bssid } = target;
		joiningSSID = ssid;
		disconnectFeedback = false;
		wifiFeedback = { ...target };
		busy = true;
		message = '';
		reported = false;
		try {
			const state = await joinWifiNetwork(interfaceID, ssid, bssid, password, target.security, target.ssidHex);
			await syncAfterWifiMutation(state);
			failed = false;
			message = $t('settings.network.joined', { ssid });
			selection = null;
			password = '';
			reported = true;
		} catch (error) {
			await syncAfterWifiMutation();
			failed = true;
			message = translateError(error);
			reported = true;
		} finally {
			joiningSSID = null;
			busy = false;
			void refreshWifiNetworks();
		}
	}

	async function disconnect(): Promise<void> {
		if (busy || scanning || !canEditWifi || !iface?.wifi?.ssid) return;
		clearMessage();
		busy = true;
		disconnecting = true;
		disconnectFeedback = true;
		try {
			await disconnectWifiNetwork(interfaceID);
			selection = null;
			password = '';
			failed = false;
			message = $t('settings.network.disconnected');
			reported = true;
		} catch (error) {
			await syncAfterWifiMutation();
			failed = true;
			message = translateError(error);
			reported = true;
		} finally {
			disconnecting = false;
			busy = false;
			void refreshWifiNetworks();
		}
	}

	function sameNetwork(left: NetWifiNetwork, right: NetWifiNetwork): boolean {
		return left.ssid === right.ssid && left.bssid === right.bssid && left.security === right.security && left.ssidHex === right.ssidHex;
	}

	function networkLabel(network: NetWifiNetwork): string {
		const duplicate = networks.some(item => item !== network && item.ssid === network.ssid);
		return duplicate && network.bssid ? `${network.ssid} — ${network.bssid}` : network.ssid;
	}

	/**
	 * Offer only what a join will accept.
	 *
	 * Every one of these is refused by the backend anyway; leaving the row live let
	 * the user pick it, type a password and only then be told no. The already-joined
	 * case is the worst of the three, because the password is typed in full first.
	 */
	function joinable(network: NetWifiNetwork): boolean {
		return network.supported && network.connectable !== false && !network.active && isUnambiguousWifiTarget(networks, network);
	}

	/** What the row says about itself, with the reason it cannot be picked winning. */
	function networkStatus(network: NetWifiNetwork): string {
		if (!network.supported) return $t('settings.network.unsupportedSecurity');
		if (network.active) return $t('settings.network.alreadyJoined');
		if (network.connectable === false) return network.unavailableReason || $t('settings.network.notConnectable');
		if (!isUnambiguousWifiTarget(networks, network)) return $t('settings.network.ambiguousName');
		return network.secured ? $t('settings.network.secured') : $t('settings.network.open');
	}

	// Row positions shift with the mode: the static fields exist only in 'static'.
	let staticRows = $derived(mode === 'static' ? 3 : 0);
	let dnsRows = $derived(dnsMode === 'custom' ? 2 : 1);
	let ipv4BaseY = $derived(canEditWifi && iface?.wifi?.ssid ? 1 : 0);
	let saveY = $derived(canEditIPv4 ? ipv4BaseY + 1 + staticRows + dnsRows : ipv4BaseY);
	let wifiBaseY = $derived(canEditIPv4 ? saveY + 1 : ipv4BaseY);
	let selectionIndex = $derived(selectedNetwork ? networks.indexOf(selectedNetwork) : -1);
	let feedbackIndex = $derived(wifiFeedback ? networks.findIndex(network => sameNetwork(network, wifiFeedback!)) : -1);
	let buttonsY = $derived(canEditWifi ? wifiBaseY + 1 + networks.length + (selection ? 2 : 0) : wifiBaseY);

	function wifiRowY(index: number): number {
		return wifiBaseY + 1 + index + (selectionIndex >= 0 && index > selectionIndex ? 2 : 0);
	}

	createNavArea(() => ({ areaID, position, onBack, activate: true }));
</script>

<style>
	.settings {
		display: flex;
		flex-direction: column;
		align-items: center;
		height: 100%;
		padding: 2vh 2vw;
		gap: 1.6vh;
		overflow-y: auto;
		color: var(--secondary-foreground);
		box-sizing: border-box;
	}

	.container { width: min(100%, 850px); min-width: 0; }
	.settings :global(.button.selected), .settings :global(.button:hover), .settings :global(.button:active) { transform: none; box-shadow: none; }
	.settings :global(.button.selected) { border-color: var(--primary-foreground); }
	.header, .toolbar { display: flex; align-items: center; justify-content: space-between; gap: 1.5vh; }
	.header { justify-content: flex-start; padding-bottom: 1.8vh; }
	h2, h3, h4, p { margin: 0; }
	h2 { font-size: clamp(20px, 2.7vh, 28px); color: var(--primary-foreground); }
	h3 { font-size: clamp(16px, 2vh, 21px); color: var(--primary-foreground); }
	.connection { padding: 1.4vh; margin-bottom: 1.4vh; background: var(--secondary-background); border-radius: 1vh; }
	.connection-main { display: flex; align-items: center; justify-content: space-between; gap: 1.4vh; flex-wrap: wrap; }
	.connection h4 { font-size: clamp(17px, 2.2vh, 23px); margin: 0.6vh 0; overflow-wrap: anywhere; }
	.connection-details { display: flex; gap: 0.5vh 2vh; flex-wrap: wrap; font-size: clamp(13px, 1.65vh, 17px); }
	.device { font-size: clamp(12px, 1.5vh, 15px); opacity: 0.75; }
	.section { padding: 1.8vh 0; border-top: 1px solid var(--secondary-softer-background); }
	.toolbar { margin-bottom: 1.2vh; flex-wrap: wrap; }
	.note { font-size: clamp(13px, 1.65vh, 17px); line-height: 1.45; color: var(--secondary-foreground); opacity: 0.85; }
	.warning { margin-bottom: 1.4vh; }
	.fields { display: flex; flex-direction: column; gap: 1vh; margin-bottom: 1.2vh; }
	.static-fields { display: grid; grid-template-columns: minmax(0, 2fr) minmax(85px, 1fr) minmax(0, 2fr); gap: 1vh; }
	.fields :global(.input-field), .fields :global(.select-field) { min-width: 0; }
	.fields :global(.label), .join-panel :global(.label) { color: var(--secondary-foreground); font-size: clamp(13px, 1.65vh, 17px); }
	.fields :global(input), .fields :global(select), .join-panel :global(input) { color: var(--secondary-foreground); background-color: var(--secondary-background); }
	.fields :global(.input-field.disabled input), .fields :global(.select-field.disabled select), .join-panel :global(.input-field.disabled input) { color: var(--disabled-foreground); background-color: var(--secondary-hard-background); }
	.wifi-list { display: flex; flex-direction: column; gap: 0.6vh; }
	.wifi-row { min-width: 0; }
	.wifi-row :global(.button) { justify-content: flex-start; text-align: left; white-space: normal; min-width: 0; transform: none; opacity: 1; border-width: 2px; }
	.wifi-row :global(.button.disabled) { opacity: 0.65; }
	.wifi-row.chosen :global(.button) { border-color: var(--primary-foreground); }
	.network { display: flex; align-items: center; justify-content: space-between; gap: 1.5vh; flex: 1; min-width: 0; }
	.network-copy { display: flex; flex-direction: column; gap: 0.3vh; min-width: 0; }
	.network-name { font-size: clamp(15px, 1.9vh, 20px); font-weight: 600; overflow-wrap: anywhere; }
	.network-status { font-size: clamp(12px, 1.55vh, 16px); font-weight: 400; line-height: 1.35; }
	.security { opacity: 0.8; }
	.signal { display: flex; flex-direction: column; align-items: flex-end; gap: 0.2vh; flex-shrink: 0; font-size: clamp(15px, 1.9vh, 20px); font-variant-numeric: tabular-nums; }
	.signal-label { font-size: clamp(11px, 1.4vh, 14px); font-weight: 400; opacity: 0.8; }
	.join-panel { padding: 1.2vh 1.4vh; margin: 0.4vh 0 1vh; border-left: 2px solid var(--primary-foreground); background: var(--secondary-background); display: flex; flex-direction: column; gap: 1vh; }
	.loading, .empty { display: flex; align-items: center; gap: 1.2vh; padding: 1.4vh; background: var(--secondary-background); border-radius: 1vh; }
	.loading { margin-bottom: 0.8vh; }
	.loading strong { display: block; font-size: clamp(14px, 1.8vh, 18px); margin-bottom: 0.2vh; }
	.message { margin-top: 1vh; padding: 1.2vh 1.4vh; font-size: clamp(13px, 1.75vh, 18px); line-height: 1.45; color: var(--secondary-foreground); background: var(--secondary-background); border-left: 3px solid var(--primary-foreground); border-radius: 0 0.8vh 0.8vh 0; }
	.message.failed { color: var(--error-foreground, #d33); border-left-color: var(--error-foreground, #d33); }
	.reload-note { margin-top: 0.8vh; }
	.joining { display: flex; align-items: center; gap: 1vh; padding: 1vh 0; }
	.joining strong { display: block; margin-bottom: 0.25vh; }
	.spinner { width: 1.7vh; height: 1.7vh; min-width: 14px; min-height: 14px; border: 2px solid var(--secondary-softer-background); border-top-color: var(--primary-foreground); border-radius: 50%; animation: spin 0.8s linear infinite; }
	@keyframes spin { to { transform: rotate(360deg); } }
	@media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }

	@media (max-width: 600px) {
		.settings { padding: 1.5vh 3vw; }
		.static-fields { grid-template-columns: minmax(0, 1fr); }
		.toolbar { align-items: flex-start; }
	}
</style>

{#snippet wifiStatus()}
	{#if joiningSSID !== null}
		<div class="joining" role="status" aria-live="polite">
			<span class="spinner" aria-hidden="true"></span>
			<div><strong>{$t('settings.network.joining')}</strong><p class="note">{$t('settings.network.joiningHint', { ssid: joiningSSID })}</p></div>
		</div>
	{:else if message}
		<div class="message" class:failed role="status" aria-live="polite">{message}</div>
	{/if}
{/snippet}

{#snippet joinPanel(rowY: number)}
	{#if selection}
		<div class="join-panel">
			{#if wifiFeedback && selection && sameNetwork(wifiFeedback, selection)}{@render wifiStatus()}{/if}
			<div role="group" data-mouse-activate-area={areaID}>
				<Input bind:value={password} onchange={clearMessage} label={$t('settings.network.passwordFor', { ssid: selection.ssid })} type="password" position={[0, rowY]} disabled={busy} fontSize="clamp(14px, 1.8vh, 18px)" padding="0.85vh 1.2vh" flex />
			</div>
			<ButtonBar justify="flex-end" basePosition={[0, rowY + 1]}>
				<Button icon="/img/check.svg" label={joiningSSID !== null ? $t('settings.network.joining') : $t('settings.network.join')} position={[0, rowY + 1]} padding="0.9vh 1.4vh" fontSize="clamp(14px, 1.8vh, 18px)" disabled={busy || scanning || !selectedNetwork || !joinable(selectedNetwork)} onConfirm={join} />
			</ButtonBar>
			{#if !selectedNetwork}
				<div class="note">{$t('settings.network.selectionChanged')}</div>
			{/if}
		</div>
	{/if}
{/snippet}

<div class="settings">
	<div class="container">
		<header class="header">
			<Icon img={iface?.medium === 'wireless' ? '/img/wifi.svg' : '/img/ethernet.svg'} size="3.2vh" colorVariable="--primary-foreground" />
			<div>
				<h2>{iface?.name ?? interfaceID}</h2>
				{#if iface?.name !== interfaceID}<div class="device">{interfaceID}</div>{/if}
			</div>
		</header>

		{#if iface?.medium === 'wireless'}
			<section class="connection" aria-label={$t('settings.network.currentConnection')}>
				<div class="connection-main">
					<div>
						<div class="note">{$t('settings.network.currentConnection')}</div>
						<h4>{iface.wifi?.ssid ?? $t('settings.network.notConnected')}</h4>
						<div class="connection-details">
							{#if iface.wifi?.signal !== null && iface.wifi?.signal !== undefined}<span>{$t('settings.network.signal')}: {iface.wifi.signal}%</span>{/if}
							{#each iface.addresses as item}<span>{item.family === 'ipv4' ? 'IPv4' : 'IPv6'}: {item.address}</span>{/each}
						</div>
					</div>
					{#if canEditWifi && iface.wifi?.ssid}
						<ButtonBar basePosition={[0, 0]}>
							<Button icon="/img/cross.svg" label={disconnecting ? $t('settings.network.disconnecting') : $t('settings.network.disconnect')} position={[0, 0]} padding="0.9vh 1.4vh" fontSize="clamp(14px, 1.8vh, 18px)" disabled={busy || scanning} onConfirm={disconnect} />
						</ButtonBar>
					{/if}
				</div>
				{#if disconnecting}<div class="joining" role="status" aria-live="polite"><span class="spinner" aria-hidden="true"></span><strong>{$t('settings.network.disconnecting')}</strong></div>
				{:else if disconnectFeedback && message}<div class="message" class:failed role="status" aria-live="polite">{message}</div>{/if}
			</section>
		{/if}

		{#if canEditIPv4}
			<section class="section" aria-label="IPv4">
				<div class="toolbar"><h3>IPv4</h3></div>
				<p class="note warning">{$t('settings.network.applyWarning')}</p>
				<div class="fields">
					<div role="group" data-mouse-activate-area={areaID}>
						<Select bind:value={mode} onchange={clearMessage} label={$t('settings.network.addressing')} position={[0, ipv4BaseY]} disabled={busy} fontSize="clamp(14px, 1.8vh, 18px)" padding="0.85vh 1.2vh" flex>
							<SelectOption value="dhcp" label={$t('settings.network.dhcp')} />
							<SelectOption value="static" label={$t('settings.network.static')} />
						</Select>
					</div>
					{#if mode === 'static'}
						<div class="static-fields" role="group" data-mouse-activate-area={areaID}>
							<Input bind:value={address} onchange={clearMessage} label={$t('settings.network.field.address')} placeholder="192.168.1.10" position={[0, ipv4BaseY + 1]} disabled={busy} fontSize="clamp(14px, 1.8vh, 18px)" padding="0.85vh 1.2vh" flex />
							<Input bind:value={prefix} onchange={clearMessage} label={$t('settings.network.field.prefixLength')} type="number" min={1} max={32} position={[0, ipv4BaseY + 2]} disabled={busy} fontSize="clamp(14px, 1.8vh, 18px)" padding="0.85vh 1.2vh" flex />
							<Input bind:value={gateway} onchange={clearMessage} label={$t('settings.network.field.gateway')} placeholder="192.168.1.1" position={[0, ipv4BaseY + 3]} disabled={busy} fontSize="clamp(14px, 1.8vh, 18px)" padding="0.85vh 1.2vh" flex />
						</div>
					{/if}
					<div role="group" data-mouse-activate-area={areaID}>
						<Select bind:value={dnsMode} onchange={clearMessage} label={$t('settings.network.dnsPolicy')} position={[0, ipv4BaseY + 1 + staticRows]} disabled={busy} fontSize="clamp(14px, 1.8vh, 18px)" padding="0.85vh 1.2vh" flex>
							<SelectOption value="unchanged" label={$t('settings.network.dnsUnchanged')} />
							<SelectOption value="automatic" label={$t('settings.network.dnsAutomatic')} />
							<SelectOption value="custom" label={$t('settings.network.dnsCustom')} />
						</Select>
						{#if dnsMode === 'custom'}
							<Input bind:value={dns} onchange={clearMessage} label={$t('settings.network.field.dns')} placeholder="192.168.1.1, 2001:db8::53" position={[0, ipv4BaseY + 2 + staticRows]} disabled={busy} fontSize="clamp(14px, 1.8vh, 18px)" padding="0.85vh 1.2vh" flex />
						{/if}
					</div>
				</div>
				<ButtonBar justify="flex-end" basePosition={[0, saveY]} gap="1vh">
					<Button icon="/img/check.svg" label={busy && joiningSSID === null && !disconnecting ? $t('settings.network.applying') : $t('common.save')} position={[0, saveY]} padding="0.9vh 1.4vh" fontSize="clamp(14px, 1.8vh, 18px)" disabled={busy || scanning || stale} onConfirm={save} />
					{#if stale}
						<Button icon="/img/back.svg" label={$t('settings.network.reloadForm')} position={[1, saveY]} padding="0.9vh 1.4vh" fontSize="clamp(14px, 1.8vh, 18px)" disabled={busy || scanning} onConfirm={reloadForm} />
					{/if}
				</ButtonBar>
			</section>
		{/if}

		{#if canEditWifi}
			<section class="section" aria-label={$t('settings.network.availableNetworks')}>
				<div class="toolbar">
					<h3>{$t('settings.network.availableNetworks')}</h3>
					<ButtonBar basePosition={[0, wifiBaseY]}>
						<Button icon="/img/search.svg" label={scanning ? $t('settings.network.scanning') : $t('settings.network.scan')} position={[0, wifiBaseY]} padding="0.9vh 1.4vh" fontSize="clamp(14px, 1.8vh, 18px)" disabled={scanning || busy} onConfirm={scan} />
					</ButtonBar>
				</div>
				{#if scanning}
					<div class="loading" role="status">
						<Icon img="/img/wifi.svg" size="2.5vh" colorVariable="--secondary-foreground" />
						<div><strong>{$t('settings.network.scanning')}</strong><p class="note">{$t('settings.network.scanningHint')}</p></div>
					</div>
				{:else if networks.length === 0 && !message}
					<div class="empty"><p class="note">{$t('settings.network.scanHint')}</p></div>
				{/if}
				{#if wifiFeedback && feedbackIndex < 0 && !selection}{@render wifiStatus()}{/if}
				<div class="wifi-list">
					{#each networks as network, index (`${network.ssid}:${network.bssid ?? ''}:${network.security}:${network.ssidHex ?? ''}`)}
						<div class="wifi-row" class:chosen={index === selectionIndex} role="group" data-mouse-activate-area={areaID}>
							<Button label="{networkLabel(network)}{network.active ? ' ✓' : ''}" icon="/img/wifi.svg" iconSize="2.5vh" width="100%" padding="1vh 1.4vh" position={[0, wifiRowY(index)]} onConfirm={() => selectNetwork(network)} disabled={busy || scanning || !joinable(network)}>
								<div class="network">
									<div class="network-copy">
										<span class="network-name">{networkLabel(network)}{network.active ? ' ✓' : ''}</span>
										<span class="network-status">{#if joiningSSID !== null && wifiFeedback && sameNetwork(wifiFeedback, network)}{$t('settings.network.joining')}{:else}{networkStatus(network)}{#if network.security}<span class="security"> · {network.security}</span>{/if}{/if}</span>
									</div>
									<div class="signal"><span>{network.signal !== null ? `${network.signal}%` : '—'}</span><span class="signal-label">{$t('settings.network.signal')}</span></div>
								</div>
							</Button>
						</div>
						{#if index === selectionIndex}{@render joinPanel(wifiRowY(index) + 1)}
						{:else if index === feedbackIndex}{@render wifiStatus()}{/if}
					{/each}
				</div>
				{#if selection && selectionIndex < 0}{@render joinPanel(wifiBaseY + 1 + networks.length)}{/if}
			</section>
		{/if}

		{#if message && (!wifiFeedback || !canEditWifi) && !disconnectFeedback}<div class="message" class:failed role="status">{message}</div>{/if}
		{#if stale && message !== $t('settings.network.changedOutside')}<p class="note reload-note">{$t('settings.network.reloadRequired')}</p>{/if}
	</div>
	<ButtonBar justify="center" basePosition={[0, buttonsY + 1]}>
		<Button icon="/img/back.svg" label={$t('common.back')} position={[0, buttonsY + 1]} padding="1vh 1.6vh" fontSize="clamp(14px, 1.8vh, 18px)" onConfirm={onBack} />
	</ButtonBar>
</div>
