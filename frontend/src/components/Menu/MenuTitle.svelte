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
		color: #fd1;
		text-align: center;
	}
</style>

<div class="title">{title}</div>
