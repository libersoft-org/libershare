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
		padding: 4vh;
		color: #fff;
		flex: 1;
	}

	.dialog .content {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 3vh;
		padding: 4vh;
		background-color: rgba(255, 255, 255, 0.05);
		border-radius: 2vh;
		box-shadow: 0 0 2vh rgba(0, 0, 0, 0.5);
	}
</style>

<div class="dialog">
	<div class="content" style:min-width={minWidth}>
		{@render children()}
	</div>
</div>
