<script lang="ts">
	import type { Snippet } from 'svelte';
	interface Props {
		title?: string;
		minWidth?: string;
		children: Snippet;
	}
	let { title, minWidth = '0', children }: Props = $props();
</script>

<style>
	.dialog-wrapper {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		flex: 1;
	}

	.dialog {
		display: flex;
		flex-direction: column;
		align-items: center;
		background-color: var(--secondary-background);
		border: 0.2vh solid var(--secondary-soft-background);
		border-radius: 2vh;
		box-shadow: 0 0 4vh var(--secondary-background);
		overflow: hidden;
	}

	.dialog .title {
		display: flex;
		justify-content: center;
		width: 100%;
		padding: 1vh;
		font-size: 3vh;
		font-weight: bold;
		color: var(--primary-foreground);
		background-color: var(--secondary-soft-background);
	}

	.dialog .body {
		color: var(--secondary-foreground);
		padding: 2vh;
	}
</style>

<div class="dialog-wrapper">
	<div class="dialog" style:min-width={minWidth}>
		{#if title}
			<div class="title">{title}</div>
		{/if}
		<div class="body">
			{@render children()}
		</div>
	</div>
</div>
