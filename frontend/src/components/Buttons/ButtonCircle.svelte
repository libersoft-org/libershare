<script lang="ts">
	interface Props {
		icon: string;
		alt?: string;
		onclick?: () => void;
	}
	let { icon, alt = '', onclick }: Props = $props();
</script>

<style>
	.button-circle {
		width: 3vw;
		height: 3vw;
		border-radius: 50%;
		background: #333;
		border: none;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0.5vw;
	}

	.button-circle:hover {
		background: #444;
	}

	.button-circle img {
		width: 100%;
		height: 100%;
		filter: invert(1);
	}
</style>

<button class="button-circle" {onclick}>
	<img src={icon} {alt} />
</button>
