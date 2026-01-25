<script lang="ts">
	import { onMount } from 'svelte';
	import { productName } from '../../scripts/app.ts';
	import { useArea, activeArea } from '../../scripts/areas.ts';
	import type { Position } from '../../scripts/navigationLayout.ts';
	import Button from '../Buttons/Button.svelte';
	interface Props {
		areaID: string;
		position: Position;
		onBack?: () => void;
	}
	let { areaID, position, onBack }: Props = $props();
	let active = $derived($activeArea === areaID);

	onMount(() => {
		return useArea(
			areaID,
			{
				up: () => false,
				down: () => false,
				left: () => false,
				right: () => false,
				confirmUp: () => onBack?.(),
				back: () => onBack?.(),
			},
			position
		);
	});
</script>

<style>
	.header {
		display: flex;
		align-items: center;
		gap: 1vh;
		padding: 1vh;
		background-color: var(--secondary-background);
		border-bottom: 0.2vh solid var(--secondary-softer-background);
	}

	.title {
		color: var(--primary-foreground);
		font-size: 4vh;
		font-weight: bold;
	}

	.spacer {
		flex: 1;
	}

	.debug-hint {
		text-align: right;
		color: var(--secondary-foreground);
		font-size: 1.4vh;
		opacity: 0.6;
		flex-shrink: 1;
		min-width: 0;
		overflow: hidden;
	}

	.debug-hint div {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>

<div class="header">
	<Button icon="/img/back.svg" alt="Back" selected={active} padding="1vh" width="5vh" height="5vh" borderRadius="50%" />
	<div class="title">{productName}</div>
	<div class="spacer"></div>
	<div class="debug-hint">
		<div>F2 / START = debug</div>
		<div>F3 / SELECT = reload</div>
	</div>
</div>
