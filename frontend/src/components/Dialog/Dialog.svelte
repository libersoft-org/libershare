<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		children: Snippet;
		minWidth?: string;
	}

	let { children, minWidth = '0vw' }: Props = $props();
</script>

<style>
	.dialog {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 2vw;
		color: #fff;
		flex: 1;
	}

	.dialog .content {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 1.5vw;
		padding: 2vw;
		background-color: rgba(255, 255, 255, 0.05);
		border-radius: 1vw;
		box-shadow: 0 0 1vw rgba(0, 0, 0, 0.5);
	}
</style>

<div class="dialog">
	<div class="content" style:min-width={minWidth}>
		{@render children()}
	</div>
</div>
