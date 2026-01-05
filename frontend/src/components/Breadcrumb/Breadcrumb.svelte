<script lang="ts">
	interface Props {
		items: string[];
	}
	let { items }: Props = $props();
</script>

<style>
	.breadcrumb {
		width: 100%;
		padding: 1vw;
		background-color: #222;
		font-size: 1vw;
		box-sizing: border-box;
		display: flex;
		align-items: center;
		gap: 0.5vw;
	}

	.breadcrumb-item {
		color: #888;
	}

	.breadcrumb-item.current {
		color: #fff;
		font-weight: bold;
	}

	.separator {
		color: #666;
	}
</style>

<div class="breadcrumb">
	{#each items as item, index (index)}
		{#if index > 0}
			<span class="separator">&gt;</span>
		{/if}
		<span class="breadcrumb-item" class:current={index === items.length - 1}>{item}</span>
	{/each}
</div>
