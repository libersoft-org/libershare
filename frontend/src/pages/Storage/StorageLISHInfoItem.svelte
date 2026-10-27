<script lang="ts">
	import { t } from '../../scripts/language.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import { type ILISHFileInspection } from '@shared';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import Alert from '../../components/Alert/Alert.svelte';
	import NetworkLishDetailView from '../Network/NetworkLishDetailView.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		/** One manifest of a .lishs file. */
		item: ILISHFileInspection;
		/** Translated refusal of {@link item}, empty when it is valid. */
		error: string;
		onBack?: (() => void) | undefined;
	}
	let { areaID, position = LAYOUT.content, item, error, onBack }: Props = $props();

	// y=0 — Back; y=1+ — the file tree, a list open at the bottom like on the main info page.
	createNavArea(() => ({ areaID, position, onBack, activate: true, listRange: (): [number, number] => [1, Number.MAX_SAFE_INTEGER] }));
</script>

<style>
	.lish-info-item {
		display: flex;
		flex-direction: column;
		align-items: center;
		flex: 1;
		min-height: 0;
		padding: 2vh;
		gap: 2vh;
		overflow-y: auto;
	}

	.container {
		display: flex;
		flex-direction: column;
		align-items: stretch;
		gap: 2vh;
		width: 1200px;
		max-width: calc(94vw);
		padding: 2vh;
		border-radius: 2vh;
		box-sizing: border-box;
		background-color: var(--secondary-background);
		box-shadow: 0 0 2vh var(--secondary-background);
	}

	@media (max-width: 1199px) {
		.container {
			max-width: calc(100vw);
			margin: 0;
			border-radius: 0;
			box-shadow: none;
		}
	}
</style>

<div class="lish-info-item">
	<div class="container">
		<ButtonBar basePosition={[0, 0]}>
			<Button icon="/img/back.svg" label={$t('common.back')} onConfirm={onBack} width="auto" />
		</ButtonBar>
		{#if error}
			<Alert type="error" message={error} />
		{/if}
		{#if item.detail}
			<NetworkLishDetailView detail={item.detail} fileRowsBaseY={1} />
		{/if}
	</div>
</div>
