<script lang="ts">
	import { COMPRESSION_ALGORITHMS, type CompressionAlgorithm } from '@shared';
	import { type NavPos } from '../../scripts/navArea.svelte.ts';
	import Button from '../Buttons/Button.svelte';

	interface Props {
		label: string;
		value: CompressionAlgorithm;
		/** Row index in the parent NavArea grid; one button per algorithm occupies column 0..n. */
		row: number;
		onSelect: (algorithm: CompressionAlgorithm) => void;
	}

	let { label, value, row, onSelect }: Props = $props();
	const position = (index: number): NavPos => [index, row];
</script>

<style>
	.label {
		font-size: 2vh;
		color: var(--disabled-foreground);
		margin-top: 1vh;
	}

	.selector {
		display: flex;
		flex-wrap: wrap;
		gap: 1vh;
	}
</style>

<div>
	<div class="label">{label}:</div>
	<div class="selector">
		{#each COMPRESSION_ALGORITHMS as algorithm, i}
			<Button label={algorithm} position={position(i)} active={value === algorithm} onConfirm={() => onSelect(algorithm)} padding="1vh 2vh" fontSize="2vh" borderRadius="1vh" />
		{/each}
	</div>
</div>
