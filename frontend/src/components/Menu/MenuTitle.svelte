<script lang="ts">
	interface Props {
		title: string;
	}
	let { title }: Props = $props();
</script>

<style>
	.title {
		font-size: 4vh;
		font-weight: bold;
		margin-bottom: 3vh;
		text-align: center;
		color: var(--primary-foreground);
	}
</style>

<div class="title">{title}</div>
