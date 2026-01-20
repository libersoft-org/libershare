<script lang="ts">
	import { t } from '../../scripts/language.ts';

	type ConnectionType = 'ethernet' | 'wifi';

	interface Props {
		type: ConnectionType;
		connected: boolean;
		signal?: number; // 0-100 for wifi, ignored for ethernet
	}

	const { type = 'ethernet', connected = false, signal = 0 }: Props = $props();

	// Calculate how many bars should be active (1-4), 0 if disconnected
	function getActiveBars(signalStrength: number): number {
		if (!connected) return 0;
		if (signalStrength >= 75) return 4;
		if (signalStrength >= 50) return 3;
		if (signalStrength >= 25) return 2;
		return 1;
	}

	// Get bar color based on signal strength
	function getBarColor(barIndex: number, activeBars: number): string {
		if (barIndex >= activeBars) return 'var(--secondary-softer-background)';
		if (activeBars === 1) return '#e74c3c'; // Red - poor
		if (activeBars === 2) return '#f39c12'; // Orange - fair
		if (activeBars === 3) return '#f1c40f'; // Yellow - good
		return '#2ecc71'; // Green - excellent
	}

	let activeBars = $derived(type === 'ethernet' ? (connected ? 4 : 0) : getActiveBars(signal));
	let label = $derived.by(() => {
		if (!connected) return $t.common?.disconnected;
		if (type === 'ethernet') return $t.common?.connected;
		return `${signal}%`;
	});

	// Ethernet icon color based on connection state
	let ethernetColor = $derived(connected ? '#2ecc71' : 'var(--secondary-softer-background)');
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

	/* Ethernet icon */
	.ethernet {
		width: 2.4vh;
		height: 2.4vh;
		border: 0.25vh solid var(--ethernet-color);
		border-radius: 0.3vh;
		position: relative;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.ethernet::before {
		content: '';
		position: absolute;
		width: 0.9vh;
		height: 0.9vh;
		border: 0.2vh solid var(--ethernet-color);
		border-radius: 0.15vh;
	}

	.ethernet::after {
		content: '';
		position: absolute;
		bottom: -0.6vh;
		width: 0.5vh;
		height: 0.6vh;
		background-color: var(--ethernet-color);
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
	}
</style>

<div class="connection">
	<div class="icon">
		{#if type === 'ethernet'}
			<div class="ethernet" style="--ethernet-color: {ethernetColor}"></div>
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
