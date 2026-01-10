<script lang="ts">
	import { t } from '../../scripts/language.ts';
	import { volume } from '../../scripts/settings.ts';
</script>

<style>
	.volume {
		display: flex;
		align-items: center;
		flex-direction: column;
		gap: 0.3vh;
	}

	.icon {
		width: 3vh;
		height: 3vh;
	}
</style>

<div class="volume">
	<div class="value">{$volume}%</div>
	<img class="icon" src="/img/volume.svg" alt={$t.common?.volume} />
</div>
