<script lang="ts">
	import { t } from '../../scripts/language.ts';
	import Dot from '../../components/Dot/Dot.svelte';
	interface Props {
		connected?: boolean;
	}
	const { connected = false }: Props = $props();
</script>

<style>
	.item {
		display: flex;
		align-items: center;
		flex-direction: column;
		gap: 0.5vh;
	}
</style>

<div class="item">
	<div class="top">{$t('settings.footerWidgets.gamepad')}</div>
	<div class="bottom">
		<Dot status={connected ? 'success' : 'error'} />
	</div>
</div>
