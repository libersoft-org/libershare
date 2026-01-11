<script lang="ts">
	import { t } from '../../scripts/language.ts';
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
		justify-content: flex-end;
		background-color: var(--secondary-background);
		color: var(--primary-foreground);
		padding: 1vh 1.5vh;
		font-size: 1.6vh;
		border-block: 0.2vh solid var(--secondary-softer-background);
	}

	.items {
		display: flex;
		flex-direction: row-reverse;
		align-items: center;
		overflow-x: auto;
		scrollbar-width: none;
	}

	.items::-webkit-scrollbar {
		display: none;
	}
</style>

<div class="footer">
	<div class="items">
		<Clock />
		<Separator />
		<Item icon="img/volume.svg" topLabel="{$volume}%" alt={$t.common?.volume} />
		<Separator />
		<Bar topLabel="STORAGE - 0.88 / 2 TB" progress={44.1} />
		<Separator />
		<Bar topLabel="RAM - 12.1 / 32 GB" progress={32} />
		<Separator />
		<Bar topLabel="CPU" progress={12} />
		<Separator />
		<Item icon="img/upload.svg" topLabel="3.2 MB/s" alt={$t.common?.upload} />
		<Separator />
		<Item icon="img/download.svg" topLabel="12.5 MB/s" alt={$t.common?.download} />
		<Separator />
		<Item topLabel={$t.common?.version} bottomLabel={productVersion} alt={$t.common?.version} />
	</div>
</div>
