<script lang="ts">
	interface Props {
		title: string;
	}
	let { title }: Props = $props();
</script>

<style>
	.title {
		display: flex;
		justify-content: center;
		width: 100%;
		padding: 1vh;
		font-size: 4vh;
		font-weight: bold;
		text-align: center;
		background-color: var(--secondary-soft-background);
		color: var(--primary-foreground);
	}
</style>

<div class="title">{title}</div>
