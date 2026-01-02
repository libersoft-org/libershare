<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		children: Snippet;
		minWidth?: string;
	}

	let { children, minWidth = '400px' }: Props = $props();
</script>

<style>
	.dialog-backdrop {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 2rem;
		color: #fff;
		flex: 1;
	}

	.dialog-content {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 1.5rem;
		padding: 2rem 3rem;
		background-color: rgba(255, 255, 255, 0.05);
		border-radius: 1rem;
		box-shadow: 0 0 2rem rgba(0, 0, 0, 0.5);
	}
</style>

<div class="dialog-backdrop">
	<div class="dialog-content" style:min-width={minWidth}>
		{@render children()}
	</div>
</div>
