<script lang="ts">
	import { t, translateError } from '../../scripts/language.ts';
	import { get } from 'svelte/store';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import { applyInterfaceConfig, joinWifiNetwork, networkState, refreshNetworkState, scanWifiNetworks } from '../../scripts/networkState.ts';
	import { networkConfigFormFrom, networkConfigFromForm, validateNetworkConfigForm, type DnsUpdateMode, type NetworkConfigForm } from '../../scripts/networkConfig.ts';
	import { ipv4BaselineOf, sameIPv4Baseline, type NetAddressMode, type NetInterfaceInfo, type NetIPv4Baseline, type NetIPv4Config, type NetWifiNetwork, type NetworkStateInfo } from '@shared';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
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
	let message = $state('');
	let failed = $state(false);
	let networks = $state<NetWifiNetwork[]>([]);
	let scanning = $state(false);
	let joinSSID = $state('');
	let joinBSSID = $state<string | null>(null);
	let password = $state('');

	// Seed the form from the live state when the screen opens, then keep it in
	// step with the host only while the user has not started editing. Re-seeding
	// over typed input would throw the user's work away; saving typed input over a
	// configuration that changed underneath would throw the host's change away,
	// so that case blocks Save until the user reloads the form.
	let baseline = $state<NetIPv4Baseline | null>(null);
	let seededForm: NetworkConfigForm | null = null;
	let stale = $state(false);
	$effect(() => {
		if (!iface) return;
		if (!baseline) return seedFrom(iface);
		if (sameIPv4Baseline(ipv4BaselineOf(iface), baseline)) return;
		if (formDirty()) {
			stale = true;
			failed = true;
			message = $t('settings.network.changedOutside');
			return;
		}
		seedFrom(iface);
		failed = false;
		message = $t('settings.network.reloadedFromHost');
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

	function reloadForm(): void {
		if (iface) seedFrom(iface);
		failed = false;
		message = '';
	}

	function seedCurrentInterface(): void {
		const current = get(networkState).interfaces.find(item => item.id === interfaceID);
		if (current) seedFrom(current);
	}

	async function syncAfterWifiMutation(state?: NetworkStateInfo): Promise<void> {
		let current = state;
		if (!current) {
			try {
				current = await refreshNetworkState();
			} catch {}
		}
		const currentInterface = current?.interfaces.find(item => item.id === interfaceID);
		if (currentInterface) seedFrom(currentInterface);
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
		busy = true;
		message = '';
		try {
			await applyInterfaceConfig(interfaceID, config, expected);
			seedCurrentInterface();
			failed = false;
			message = $t('settings.network.applied');
		} catch (error) {
			failed = true;
			message = translateError(error);
			try {
				await refreshNetworkState();
				seedCurrentInterface();
			} catch {}
		} finally {
			busy = false;
		}
	}

	async function scan(): Promise<void> {
		if (scanning || busy) return;
		scanning = true;
		message = '';
		try {
			networks = await scanWifiNetworks(interfaceID);
			if (networks.length === 0) {
				failed = false;
				message = $t('settings.network.noWifiFound');
			}
		} catch (error) {
			failed = true;
			message = translateError(error);
		} finally {
			scanning = false;
		}
	}

	function selectNetwork(network: NetWifiNetwork): void {
		if (!network.supported) return;
		// An open network takes no key, and asking for one would invite the user to
		// type a password that cannot be used.
		password = '';
		if (!network.secured) {
			joinSSID = '';
			joinBSSID = null;
			void join(network);
			return;
		}
		joinSSID = network.ssid;
		joinBSSID = network.bssid;
	}

	async function join(network?: NetWifiNetwork): Promise<void> {
		const ssid = network?.ssid ?? joinSSID;
		const bssid = network?.bssid ?? joinBSSID;
		if (!ssid || busy || scanning) return;
		busy = true;
		message = '';
		try {
			const state = await joinWifiNetwork(interfaceID, ssid, bssid, password);
			await syncAfterWifiMutation(state);
			failed = false;
			message = $t('settings.network.joined', { ssid });
			joinSSID = '';
			joinBSSID = null;
			password = '';
		} catch (error) {
			await syncAfterWifiMutation();
			failed = true;
			message = translateError(error);
		} finally {
			busy = false;
			void refreshWifiNetworks();
		}
	}

	function networkLabel(network: NetWifiNetwork): string {
		const duplicate = networks.some(item => item !== network && item.ssid === network.ssid);
		return duplicate && network.bssid ? `${network.ssid} — ${network.bssid}` : network.ssid;
	}

	// Row positions shift with the mode: the static fields exist only in 'static'.
	let staticRows = $derived(mode === 'static' ? 3 : 0);
	let dnsRows = $derived(dnsMode === 'custom' ? 2 : 1);
	let saveY = $derived(canEditIPv4 ? 1 + staticRows + dnsRows : 0);
	let wifiBaseY = $derived(canEditIPv4 ? saveY + 1 : 0);
	let buttonsY = $derived(canEditWifi ? wifiBaseY + 2 + networks.length + (joinSSID ? 1 : 0) : wifiBaseY);

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

	.title {
		font-size: 2.4vh;
		font-weight: bold;
	}

	.note {
		font-size: 1.8vh;
		color: var(--disabled-foreground);
	}

	.message {
		font-size: 1.8vh;
	}

	.failed {
		color: var(--error-foreground, #d33);
	}

	.network {
		display: flex;
		justify-content: space-between;
		gap: 2vh;
		font-size: 1.9vh;
	}
</style>

<div class="settings">
	<div class="container">
		<div class="title">{iface?.name ?? interfaceID}</div>
		{#if canEditIPv4}
			<div class="note">{$t('settings.network.applyWarning')}</div>

			<div role="group" data-mouse-activate-area={areaID}>
				<Select bind:value={mode} label={$t('settings.network.addressing')} position={[0, 0]} flex>
					<SelectOption value="dhcp" label={$t('settings.network.dhcp')} />
					<SelectOption value="static" label={$t('settings.network.static')} />
				</Select>
			</div>

			{#if mode === 'static'}
				<div role="group" data-mouse-activate-area={areaID}>
					<Input bind:value={address} label={$t('settings.network.field.address')} placeholder="192.168.1.10" position={[0, 1]} flex />
					<Input bind:value={prefix} label={$t('settings.network.field.prefixLength')} type="number" min={1} max={32} position={[0, 2]} flex />
					<Input bind:value={gateway} label={$t('settings.network.field.gateway')} placeholder="192.168.1.1" position={[0, 3]} flex />
				</div>
			{/if}

			<div role="group" data-mouse-activate-area={areaID}>
				<Select bind:value={dnsMode} label={$t('settings.network.dnsPolicy')} position={[0, 1 + staticRows]} flex>
					<SelectOption value="unchanged" label={$t('settings.network.dnsUnchanged')} />
					<SelectOption value="automatic" label={$t('settings.network.dnsAutomatic')} />
					<SelectOption value="custom" label={$t('settings.network.dnsCustom')} />
				</Select>
				{#if dnsMode === 'custom'}
					<Input bind:value={dns} label={$t('settings.network.field.dns')} placeholder="192.168.1.1, 2001:db8::53" position={[0, 2 + staticRows]} flex />
				{/if}
			</div>

			<ButtonBar justify="center" basePosition={[0, saveY]}>
				<Button icon="/img/check.svg" label={busy ? $t('settings.network.applying') : $t('common.save')} disabled={busy || scanning || stale} onConfirm={save} />
				{#if stale}
					<Button icon="/img/back.svg" label={$t('settings.network.reloadForm')} disabled={busy || scanning} onConfirm={reloadForm} />
				{/if}
			</ButtonBar>
		{/if}

		{#if canEditWifi}
			<div class="title">{$t('settings.network.wifi')}</div>
			<ButtonBar justify="center" basePosition={[0, wifiBaseY]}>
				<Button icon="/img/search.svg" label={scanning ? $t('settings.network.scanning') : $t('settings.network.scan')} disabled={scanning || busy} onConfirm={scan} />
			</ButtonBar>
			{#each networks as network, index (`${network.ssid}:${network.bssid ?? ''}:${network.security}`)}
				<div role="group" data-mouse-activate-area={areaID}>
					<Button label="{networkLabel(network)}{network.active ? ' ✓' : ''}" position={[0, wifiBaseY + 1 + index]} onConfirm={() => selectNetwork(network)} disabled={busy || scanning || !network.supported} />
					<div class="network">
						<span>{network.supported ? (network.secured ? $t('settings.network.secured') : $t('settings.network.open')) : $t('settings.network.unsupportedSecurity')}</span>
						<span>{network.signal !== null ? `${network.signal}%` : '—'}</span>
					</div>
				</div>
			{/each}
			{#if joinSSID}
				<div role="group" data-mouse-activate-area={areaID}>
					<Input bind:value={password} label={$t('settings.network.passwordFor', { ssid: joinSSID })} type="password" position={[0, wifiBaseY + 1 + networks.length]} flex />
				</div>
				<ButtonBar justify="center" basePosition={[0, wifiBaseY + 2 + networks.length]}>
					<Button icon="/img/check.svg" label={$t('settings.network.join')} disabled={busy || scanning} onConfirm={join} />
				</ButtonBar>
			{/if}
		{/if}

		{#if message}
			<div class="message" class:failed>{message}</div>
		{/if}
	</div>
	<ButtonBar justify="center" basePosition={[0, buttonsY + 1]}>
		<Button icon="/img/back.svg" label={$t('common.back')} onConfirm={onBack} />
	</ButtonBar>
</div>
