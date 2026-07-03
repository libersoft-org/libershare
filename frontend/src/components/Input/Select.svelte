<script lang="ts">
	import { type Snippet } from 'svelte';
	import { getContext, onMount } from 'svelte';
	import { type NavAreaController, type NavPos, navItem } from '../../scripts/navArea.svelte.ts';
	interface Props {
		value?: string | undefined;
		label?: string | undefined;
		children: Snippet;
		selected?: boolean | undefined;
		fontSize?: string | undefined;
		padding?: string | undefined;
		flex?: boolean | undefined;
		disabled?: boolean | undefined;
		onchange?: ((value: string) => void) | undefined;
		/** Position in NavArea grid [x, y]. When set, registers with parent NavArea. */
		position?: NavPos | undefined;
		el?: HTMLElement | undefined;
	}
	let { value = $bindable(''), label, children, selected = false, fontSize = '2.5vh', padding = '1.5vh 2vh', flex = false, disabled = false, onchange, position, el = $bindable() }: Props = $props();
	const navArea = getContext<NavAreaController | undefined>('navArea');
	let selectElement: HTMLSelectElement | undefined = $state();
	let isSelected = $derived(navArea && position ? navArea.isSelected(position) : selected);

	function handleChange(event: Event): void {
		const target = event.target as HTMLSelectElement;
		value = target.value;
		onchange?.(value);
	}

	function openPicker(): void {
		try {
			selectElement?.showPicker();
		} catch (_) {
			/* not supported */
		}
	}

	onMount(() => {
		if (navArea && position)
			return navArea.register(
				navItem(
					() => position!,
					() => el,
					() => openPicker()
				)
			);
		return undefined;
	});
</script>

<style>
	.select-field {
		display: flex;
		flex-direction: column;
		gap: 0.5vh;
	}

	.label {
		font-size: 2vh;
		color: var(--disabled-foreground);
	}

	select {
		font-size: var(--select-font-size);
		padding: var(--select-padding);
		border: 0.3vh solid var(--secondary-softer-background);
		border-radius: 1vh;
		background-color: var(--secondary-background);
		color: var(--secondary-foreground);
		outline: none;
		transition: border-color 0.2s;
		cursor: pointer;
	}

	select:focus {
		border-color: var(--primary-foreground);
	}

	.select-field.selected select {
		border-color: var(--primary-foreground);
	}

	.select-field.flex {
		flex: 1;
	}

	.select-field.disabled select {
		background-color: var(--disabled-foreground);
		color: var(--disabled-background);
		border-color: var(--disabled-background);
		cursor: not-allowed;
	}
</style>

<div bind:this={el} class="select-field" class:selected={isSelected} class:flex class:disabled style="--select-font-size: {fontSize}; --select-padding: {padding};">
	{#if label}
		<div class="label">{label}:</div>
	{/if}
	<select bind:this={selectElement} bind:value {disabled} onchange={handleChange}>
		{@render children()}
	</select>
</div>
