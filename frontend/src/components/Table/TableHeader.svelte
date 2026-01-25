<script lang="ts">
	import type { Snippet } from 'svelte';
	interface Props {
		children: Snippet;
		fontSize?: string;
	}
	let { children, fontSize = '1.6vh' }: Props = $props();
</script>

<style>
	.header {
		display: grid;
		align-items: center;
		padding: 1vh 2vh;
		background-color: var(--secondary-background);
		font-weight: bold;
		grid-template-columns: var(--table-columns);
		gap: var(--table-gap, 2vh);
	}

	@media (max-width: 1199px) {
		.header {
			grid-template-columns: var(--table-columns-mobile);
		}
	}
</style>

<div class="header" style:font-size={fontSize}>
	{@render children()}
</div>
