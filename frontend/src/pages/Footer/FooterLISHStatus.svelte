<script lang="ts">
	import Icon from '../../components/Icon/Icon.svelte';
	import { t } from '../../scripts/language.ts';
	import type { MeshState } from '../../scripts/networks.ts';
	interface Props {
		connectedNetworks?: number;
		totalNetworks?: number;
		totalPeers?: number;
		/**
		 * Worst-case mesh state across joined networks. Drives the network icon
		 * colour:
		 *   `unknown`   — no networks joined → neutral.
		 *   `forming`   — mesh is still settling (no peers yet, mesh empty for
		 *                 some topic, or last graft/prune within ~5 s).
		 *   `unstable`  — median peer score below 0; heartbeat will prune.
		 *   `stable`    — quiet for ≥ 5 s, all meshes non-empty, scores ≥ 0.
		 */
		meshState?: MeshState;
	}
	const { connectedNetworks = 0, totalNetworks = 0, totalPeers = 0, meshState = 'unknown' }: Props = $props();
	const stateColorVar = $derived(meshState === 'stable' ? '--mesh-state-stable' : meshState === 'forming' ? '--mesh-state-forming' : meshState === 'unstable' ? '--mesh-state-unstable' : '--primary-foreground');
	const stateLabel = $derived($t(`settings.lishNetwork.meshState.${meshState}`));
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

<div class="item" title={stateLabel}>
	<div class="top">
		<Icon img="img/network.svg" alt={$t('settings.footerWidgets.lishStatus')} size="2vh" padding="0" colorVariable={stateColorVar} />
		<span class="value">{connectedNetworks} / {totalNetworks}</span>
	</div>
	<div class="bottom">
		<Icon img="img/person.svg" alt="" size="2vh" padding="0" colorVariable="--primary-foreground" />
		<span class="value">{totalPeers}</span>
	</div>
</div>
