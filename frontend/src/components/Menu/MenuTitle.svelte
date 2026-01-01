<script lang="ts">
	interface Props {
		title: string;
	}
	let { title }: Props = $props();
</script>

<style>
	.title {
		font-size: 2.5vw;
		font-weight: bold;
		margin-bottom: 2vw;
		color: #fd1;
		text-align: center;
	}
</style>

<div class="title">{title}</div>
