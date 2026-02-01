<script lang="ts">
	import { t } from '../../scripts/language.ts';
	import Dot from '../../components/Dot/Dot.svelte';
	import { type DotStatus } from '../../scripts/dot.ts';
	interface Props {
		networkName?: string;
		lishConnected?: boolean;
		vpnConnected?: boolean | null; // null = not used
	}
	const { networkName = '', lishConnected = false, vpnConnected = null }: Props = $props();
	let lishStatus: DotStatus = $derived(lishConnected ? 'success' : 'error');
	let vpnStatus: DotStatus = $derived(vpnConnected === null ? 'disabled' : vpnConnected ? 'success' : 'error');
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
</style>

<div class="item">
	<div class="top">
		<span class="name">{networkName || $t('common.disconnected')}</span>
	</div>
	<div class="bottom">
		<div class="network">
			<div class="label">LISH:</div>
			<Dot status={lishStatus} animate={!lishConnected} />
		</div>
		<div class="network">
			<div class="label">VPN:</div>
			<Dot status={vpnStatus} />
		</div>
	</div>
</div>
