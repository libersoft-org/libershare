<script lang="ts">
	import { t } from '../../scripts/language.ts';
	import { type ConnectionType, getActiveBars, getBarColor } from '../../scripts/footerWidgets.ts';
	import Icon from '../../components/Icon/Icon.svelte';
	interface Props {
		type: ConnectionType;
		connected: boolean;
		signal?: number; // 0-100 for wifi, ignored for ethernet
	}
	const { type = 'ethernet', connected = false, signal = 0 }: Props = $props();
	let activeBars = $derived(type === 'ethernet' ? (connected ? 4 : 0) : getActiveBars(signal, connected));
	let label = $derived.by(() => {
		if (!connected) return $t('common.disconnected');
		if (type === 'ethernet') return $t('common.connected');
		return `${signal}%`;
	});
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

<div class="connection">
	<div class="icon">
		{#if type === 'ethernet'}
			<Icon img="/img/ethernet.svg" alt={label} size="2.4vh" padding="0" colorVariable={connected ? '--color-success' : '--color-error'} />
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
