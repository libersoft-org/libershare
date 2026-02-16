<script lang="ts">
	import { t } from '../../scripts/language.ts';
	import { productName } from '../../scripts/app.ts';
	import Spinner from '../../components/Spinner/Spinner.svelte';
	interface Props {
		action: 'restart' | 'shutdown' | 'quit';
	}
	let { action }: Props = $props();
	let message = $derived(action === 'restart' ? $t('exit.restart.exiting') : action === 'shutdown' ? $t('exit.shutdown.exiting') : $t('exit.quitApplication.exiting'));
</script>

<style>
	.exit-splash {
		z-index: 9999;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 2vh;
		width: 100%;
		height: 100dvh;
		background-color: var(--secondary-background);
		color: var(--secondary-foreground);
		position: fixed;
		top: 0;
		left: 0;
	}

	.title {
		font-size: 5vh;
		font-weight: bold;
		color: var(--primary-foreground);
	}

	.status {
		font-size: 3vh;
	}
</style>

<div class="exit-splash">
	<div class="title">{productName}</div>
	<Spinner size="10vh" />
	<div class="status">{message}</div>
</div>
