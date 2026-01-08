<script lang="ts">
	interface Props {
		items: string[];
	}
	let { items }: Props = $props();
</script>

<style>
	.breadcrumb {
		flex-wrap: wrap;
		width: 100%;
		padding: 1vh;
		background-color: #222;
		font-size: 2.5vh;
		box-sizing: border-box;
		display: flex;
		align-items: center;
		gap: 2vh;
	}

	.item {
		color: #888;
	}

	.item.current {
		color: #fd1;
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
		<span class="item" class:current={index === items.length - 1}>{item}</span>
	{/each}
</div>
