<script lang="ts">
	interface Props {
		icon: string;
		alt?: string;
		selected?: boolean;
		onclick?: () => void;
	}
	let { icon, alt = '', selected = false, onclick }: Props = $props();
</script>

<style>
	.button-circle {
		width: 3vw;
		height: 3vw;
		border-radius: 50%;
		background-color: #333;
		border: 2px solid #555;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0.5vw;
		transition: all 0.2s linear;
	}

	.button-circle:hover {
		background-color: #444;
	}

	.button-circle.selected {
		background-color: rgba(255, 221, 17, 0.2);
		border-color: #fd1;
		box-shadow: 0 0 15px rgba(255, 221, 17, 0.6);
	}

	.button-circle img {
		width: 100%;
		height: 100%;
		filter: invert(1);
	}
</style>

<button class="button-circle" class:selected {onclick}>
	<img src={icon} {alt} />
</button>
