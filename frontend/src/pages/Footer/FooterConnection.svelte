<script lang="ts">
	import { t } from '../../scripts/language.ts';
	import { getActiveBars, getBarColor } from '../../scripts/footerWidgets.ts';
	import type { ConnectionStatus } from '@shared';
	import Icon from '../../components/Icon/Icon.svelte';
	/** The projected {@link ConnectionStatus}, spread by the Footer. Never synthesized. */
	type Props = ConnectionStatus;
	const { kind = 'unknown', connected = false, signal = null, ssid = null, interfaceName = null }: Props = $props();
	// Wi-Fi gets the bar glyph, everything else (cable, tunnel, unknown medium) the
	// cable icon.
	//
	// Bars state a strength, so they are only drawn when one is known: an
	// associated network whose quality the OS withholds would otherwise render as
	// four empty bars, which reads as "no signal" — a measurement nobody took.
	let signalUnknown = $derived(kind === 'wifi' && connected && signal === null);
	let showBars = $derived((kind === 'wifi' || kind === 'wifiOff') && !signalUnknown);
	let activeBars = $derived(kind === 'wifi' && signal !== null ? getActiveBars(signal, connected) : 0);
	let icon = $derived(signalUnknown ? '/img/wifi.svg' : '/img/ethernet.svg');
	// Neutral only while the carrier state is genuinely unknown. A tunnel or bridge
	// as primary still reports its link, and greying out a live VPN would understate
	// a connection the OS confirmed.
	let iconColor = $derived(kind === 'unknown' && !connected ? '--secondary-softer-background' : connected ? '--color-success' : '--color-error');
	let label = $derived.by(() => {
		if (kind === 'wifiOff') return $t('settings.footerWidgets.connectionWifiOff');
		if (kind === 'unknown') return interfaceName ?? '—';
		if (!connected) return $t('common.disconnected');
		if (kind === 'wired') return $t('common.connected');
		// Associated Wi-Fi: a real quality reading, or the network name when the OS
		// (or a missing tool) withholds it. Never a fabricated percentage.
		if (signal !== null) return `${signal}%`;
		return ssid ?? '—';
	});
	// The unknown state can only show the interface name (or a dash), which does
	// not say why — the tooltip does, the same way the volume widget explains its
	// own unavailable state.
	let title = $derived(kind === 'unknown' ? $t('settings.footerWidgets.connectionUnknown') : undefined);
</script>

<style>
	.connection {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.5vh;
	}

	.icon {
		display: flex;
		align-items: flex-end;
		gap: 0.3vh;
		height: 2.4vh;
	}

	/* Wifi bars */
	.wifi-bars {
		display: flex;
		align-items: flex-end;
		gap: 0.25vh;
	}

	.bar {
		width: 0.5vh;
		border-radius: 0.25vh;
		transition: background-color 0.3s ease;
	}

	.bar:nth-child(1) {
		height: 0.6vh;
	}

	.bar:nth-child(2) {
		height: 1.2vh;
	}

	.bar:nth-child(3) {
		height: 1.8vh;
	}

	.bar:nth-child(4) {
		height: 2.4vh;
	}

	.label {
		font-size: 1.4vh;
		color: var(--primary-foreground);
		text-align: center;
	}
</style>

<div class="connection" {title}>
	<div class="icon">
		{#if !showBars}
			<Icon img={icon} alt={label} size="2.4vh" padding="0" colorVariable={iconColor} />
		{:else}
			<div class="wifi-bars">
				{#each [0, 1, 2, 3] as barIndex}
					<div class="bar" style="background-color: {getBarColor(barIndex, activeBars)}"></div>
				{/each}
			</div>
		{/if}
	</div>
	<div class="label">{label}</div>
</div>
