<script lang="ts">
	import { productVersion } from '../../scripts/app.ts';
	import Volume from './FooterVolume.svelte';
	import Separator from './FooterSeparator.svelte';
	import Clock from './FooterClock.svelte';
</script>

<style>
	.footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		background-color: var(--secondary-background);
		color: var(--primary-foreground);
		padding: 1vh 1.5vh;
		font-size: 1.6vh;
		border-block: 0.2vh solid var(--secondary-softer-background);
	}

	.right {
		display: flex;
		align-items: center;
	}
</style>

<div class="footer">
	<div>Version: {productVersion}</div>
	<div class="right">
		<Volume />
		<Separator />
		<Clock />
	</div>
</div>
