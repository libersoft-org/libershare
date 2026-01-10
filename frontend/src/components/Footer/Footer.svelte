<script lang="ts">
	import { productVersion } from '../../scripts/app.ts';
	import { volume } from '../../scripts/settings.ts';
	import Item from './FooterItem.svelte';
	import Separator from './FooterSeparator.svelte';
	import Bar from './FooterBar.svelte';
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
		<Item icon="download" value="12.5 MB/s" alt="Download" />
		<Separator />
		<Item icon="upload" value="3.2 MB/s" alt="Upload" />
		<Separator />
		<Bar label="CPU" progress={12} />
		<Separator />
		<Bar label="RAM - 12.1 / 32 GB" progress={32} />
		<Separator />
		<Bar label="STORAGE - 0.88 / 2 TB" progress={44.1} />
		<Separator />
		<Item icon="volume" value="{$volume}%" alt="Volume" />
		<Separator />
		<Clock />
	</div>
</div>
