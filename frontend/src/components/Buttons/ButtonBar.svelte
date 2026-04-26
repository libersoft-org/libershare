<script lang="ts" module>
	import { type NavPos } from '../../scripts/navArea.svelte.ts';
	export type ButtonBarContext = {
		nextPosition: () => NavPos | undefined;
	};
</script>

<script lang="ts">
	import { type Snippet } from 'svelte';
	import { setContext, untrack } from 'svelte';
	interface Props {
		justify?: string;
		wrap?: boolean;
		gap?: string;
		direction?: 'row' | 'column';
		/** When set, child Buttons without explicit `position` get sequential positions starting here. */
		basePosition?: NavPos | undefined;
		/** Which axis to increment for sequential positions. Defaults to 'x' for row, 'y' for column. */
		axis?: 'x' | 'y' | undefined;
		children: Snippet;
		el?: HTMLElement | undefined;
	}
	let { justify = 'flex-start', wrap = true, gap = '2vh', direction = 'row', basePosition, axis, children, el = $bindable() }: Props = $props();
	void el;
	const effectiveAxis: 'x' | 'y' = untrack(() => axis ?? (direction === 'column' ? 'y' : 'x'));
	let counter = 0;
	setContext<ButtonBarContext>('buttonBar', {
		nextPosition() {
			if (!basePosition) return undefined;
			const i = counter++;
			if (effectiveAxis === 'x') return [basePosition[0] + i, basePosition[1]];
			return [basePosition[0], basePosition[1] + i];
		},
	});
</script>

<style>
	.button-bar {
		display: flex;
	}
</style>

<div bind:this={el} class="button-bar" style="flex-direction: {direction}; justify-content: {justify}; gap: {gap}; {wrap ? ' flex-wrap: wrap;' : ''}">
	{@render children()}
</div>
