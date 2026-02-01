<script lang="ts">
	import { t } from '../../scripts/language.ts';
	import Dot from '../../components/Dot/Dot.svelte';
	import { type DotStatus } from '../../scripts/dot.ts';
	interface Props {
		status?: 'online' | 'offline' | 'connecting';
	}
	const { status = 'offline' }: Props = $props();
	let dotStatus: DotStatus = $derived(status === 'online' ? 'success' : status === 'connecting' ? 'warning' : 'error');
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
		gap: 0.5vh;
		text-align: center;
	}

	.label {
		font-weight: bold;
	}
</style>

<div class="item">
	<div class="top">
		<span class="label">{$t('settings.footerWidgets.backendStatus')}</span>
	</div>
	<div class="bottom">
		<Dot status={dotStatus} />
	</div>
</div>
