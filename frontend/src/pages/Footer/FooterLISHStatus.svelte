<script lang="ts">
	import Icon from '../../components/Icon/Icon.svelte';
	import { t } from '../../scripts/language.ts';
	interface Props {
		connectedNetworks?: number;
		totalNetworks?: number;
		totalPeers?: number;
	}
	const { connectedNetworks = 0, totalNetworks = 0, totalPeers = 0 }: Props = $props();
</script>

<style>
	.item {
		display: flex;
		align-items: center;
		flex-direction: column;
		gap: 0.6vh;
	}

	.top,
	.bottom {
		display: flex;
		align-items: center;
		gap: 0.5vh;
		text-align: center;
	}
</style>

<div class="item">
	<div class="top">
		<Icon img="img/network.svg" alt={$t('settings.footerWidgets.lishStatus')} size="2vh" padding="0" colorVariable="--primary-foreground" />
		<span class="value">{connectedNetworks} / {totalNetworks}</span>
	</div>
	<div class="bottom">
		<Icon img="img/person.svg" alt="" size="2vh" padding="0" colorVariable="--primary-foreground" />
		<span class="value">{totalPeers}</span>
	</div>
</div>
