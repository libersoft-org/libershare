<script lang="ts">
	import { t, translateError } from '../../scripts/language.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import { applyInterfaceConfig, joinWifiNetwork, networkState, scanWifiNetworks } from '../../scripts/networkState.ts';
	import { isIPv4, validateIPv4Config, type NetInterfaceInfo, type NetIPv4Config, type NetWifiNetwork } from '@shared';
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
	let canEditWifi = $derived(!!iface && iface.medium === 'wireless' && $networkState.capabilities.wifi);

	let mode = $state<'dhcp' | 'static'>('dhcp');
	let address = $state('');
	let prefix = $state('24');
	let gateway = $state('');
	let dns = $state('');
	let busy = $state(false);
	let message = $state('');
	let failed = $state(false);
	let networks = $state<NetWifiNetwork[]>([]);
	let scanning = $state(false);
	let joinSSID = $state('');
	let password = $state('');

	// Seed the form from the live state once, when the screen opens. Re-seeding on
	// every broadcast would overwrite what the user is in the middle of typing.
	let seeded = false;
	$effect(() => {
		if (seeded || !iface) return;
		seeded = true;
		seedFrom(iface);
	});

	function seedFrom(source: NetInterfaceInfo): void {
		mode = source.ipv4Mode === 'static' ? 'static' : 'dhcp';
		const ipv4 = source.addresses.find(a => a.family === 'ipv4');
		address = ipv4?.address ?? '';
		prefix = String(ipv4?.prefixLength ?? 24);
		gateway = source.gateway ?? '';
		// Only real resolvers are offered back for editing: a loopback stub is what
		// the host runs, not something the user typed, and re-submitting it would
		// pin the machine to its own resolver.
		dns = source.dns.filter(server => isIPv4(server) && !server.startsWith('127.')).join(', ');
	}

	function buildConfig(): NetIPv4Config {
		if (mode === 'dhcp') return { mode: 'dhcp' };
		return {
			mode: 'static',
			address: address.trim(),
			prefixLength: Number(prefix.trim()),
			gateway: gateway.trim(),
			dns: dns
				.split(',')
				.map(server => server.trim())
				.filter(Boolean),
		};
	}

	async function save(): Promise<void> {
		if (busy || scanning) return;
		const config = buildConfig();
		const invalid = validateIPv4Config(config);
		if (invalid) {
			failed = true;
			message = $t('settings.network.invalidField', { field: $t('settings.network.field.' + invalid) });
			return;
		}
		busy = true;
		message = '';
		try {
			await applyInterfaceConfig(interfaceID, config);
			failed = false;
			message = $t('settings.network.applied');
		} catch (error) {
			failed = true;
			message = translateError(error);
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
		joinSSID = network.ssid;
		// An open network takes no key, and asking for one would invite the user to
		// type a password that cannot be used.
		password = '';
		if (!network.secured) void join();
	}

	async function join(): Promise<void> {
		if (!joinSSID || busy || scanning) return;
		busy = true;
		message = '';
		try {
			await joinWifiNetwork(interfaceID, joinSSID, password);
			failed = false;
			message = $t('settings.network.joined', { ssid: joinSSID });
			password = '';
		} catch (error) {
			failed = true;
			message = translateError(error);
		} finally {
			busy = false;
		}
	}

	// Row positions shift with the mode: the static fields exist only in 'static'.
	let staticRows = $derived(mode === 'static' ? 4 : 0);
	let wifiBaseY = $derived(1 + staticRows + 1);
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
				<Input bind:value={dns} label={$t('settings.network.field.dns')} placeholder="192.168.1.1, 1.1.1.1" position={[0, 4]} flex />
			</div>
		{/if}

		<ButtonBar justify="center" basePosition={[0, 1 + staticRows]}>
			<Button icon="/img/check.svg" label={busy ? $t('settings.network.applying') : $t('common.save')} disabled={busy || scanning} onConfirm={save} />
		</ButtonBar>

		{#if canEditWifi}
			<div class="title">{$t('settings.network.wifi')}</div>
			<ButtonBar justify="center" basePosition={[0, wifiBaseY]}>
				<Button icon="/img/search.svg" label={scanning ? $t('settings.network.scanning') : $t('settings.network.scan')} disabled={scanning || busy} onConfirm={scan} />
			</ButtonBar>
			{#each networks as network, index (network.ssid)}
				<div role="group" data-mouse-activate-area={areaID}>
					<Button label="{network.ssid}{network.active ? ' ✓' : ''}" position={[0, wifiBaseY + 1 + index]} onConfirm={() => selectNetwork(network)} disabled={busy || scanning} />
					<div class="network">
						<span>{network.secured ? $t('settings.network.secured') : $t('settings.network.open')}</span>
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
