<script lang="ts">
	import { t } from '../../scripts/language.ts';
	import { productName, productVersion } from '@shared';
	import Spinner from '../../components/Spinner/Spinner.svelte';
	interface Props {
		url: string;
	}
	let { url }: Props = $props();
</script>

<style>
	.splash {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 2vh;
		width: 100%;
		height: 100%;
		background-color: var(--secondary-background);
		color: var(--secondary-foreground);
	}

	.title {
		font-size: 5vh;
		font-weight: bold;
		color: var(--primary-foreground);
	}

	.version {
		font-size: 3vh;
		font-weight: bold;
	}

	.status {
		font-size: 3vh;
	}

	.url {
		font-family: 'Ubuntu Mono';
		font-size: 2.4vh;
		color: var(--disabled-foreground);
	}
</style>

<div class="splash">
	<div class="title">{productName}</div>
	<div class="version">{productVersion}</div>
	<Spinner size="10vh" />
	<div class="status">{$t('splash.connecting')} ...</div>
	<div class="url">{url}</div>
</div>
