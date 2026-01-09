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
		background-color: var(--secondary-soft-background);
		font-size: 2.5vh;
		box-sizing: border-box;
		display: flex;
		align-items: center;
		gap: 2vh;
	}

	.item {
		color: var(--disabled-foreground);
	}

	.item.current {
		color: var(--primary-foreground);
		font-weight: bold;
	}

	.separator {
		color: var(--disabled-foreground);
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
