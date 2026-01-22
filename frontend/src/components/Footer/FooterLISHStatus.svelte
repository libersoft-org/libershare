<script lang="ts">
	import { t } from '../../scripts/language.ts';
	interface Props {
		networkName?: string;
		lishConnected?: boolean;
		vpnConnected?: boolean | null; // null = not used
	}
	const { networkName = '', lishConnected = false, vpnConnected = null }: Props = $props();
	let lishStatus = $derived(lishConnected ? 'success' : 'error');
	let vpnStatus = $derived(vpnConnected === null ? 'warning' : vpnConnected ? 'success' : 'error');
</script>

<style>
	.item {
		display: flex;
		align-items: center;
		flex-direction: column;
		gap: 0.5vh;
	}

	.top,
	.bottom {
		display: flex;
		align-items: center;
		gap: 1vh;
		text-align: center;
	}

	.name {
		font-weight: bold;
	}

	.network {
		display: flex;
		align-items: center;
		gap: 0.5vh;
	}

	.dot {
		min-width: 1.2vh;
		min-height: 1.2vh;
		width: 1.2vh;
		height: 1.2vh;
		border-radius: 50%;
		border: 0.2vh solid var(--secondary-foreground);
	}

	.dot.success {
		background-color: var(--color-success);
	}

	.dot.warning {
		background-color: var(--color-warning);
	}

	.dot.error {
		background-color: var(--color-error);
	}
</style>

<div class="item">
	<div class="top">
		<span class="name">{networkName || ($t.common?.disconnected ?? 'Disconnected')}</span>
	</div>
	<div class="bottom">
		<div class="network">
			<div class="label">LISH:</div>
			<div class="dot {lishStatus}"></div>
		</div>
		<div class="network">
			<div class="label">VPN:</div>
			<div class="dot {vpnStatus}"></div>
		</div>
	</div>
</div>
