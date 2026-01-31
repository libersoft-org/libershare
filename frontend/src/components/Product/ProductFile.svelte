<script lang="ts">
	import Row from '../Row/Row.svelte';
	import Button from '../Buttons/Button.svelte';
	import { t } from '../../scripts/language.ts';
	interface Props {
		name: string;
		size: string;
		selected?: boolean;
		selectedButton?: number; // 0 = Download, 1 = Play
		pressed?: boolean;
	}
	let { name, size, selected = false, selectedButton = 0, pressed = false }: Props = $props();
</script>

<style>
	.info {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.5vh;
	}

	.info .name {
		font-size: 3vh;
		font-weight: bold;
		color: var(--secondary-foreground);
	}

	.info .size {
		font-size: 2vh;
		color: var(--disabled-foreground);
	}

	.actions {
		display: flex;
		gap: 2vh;
	}

	@media (max-width: 768px) {
		.actions {
			width: 100%;
		}

		.actions :global(.button) {
			flex: 1;
			min-width: unset;
		}
	}
</style>

<Row {selected}>
	<div class="info">
		<div class="name">{name}</div>
		<div class="size">{$t('library.product.size')}: {size}</div>
	</div>
	<div class="actions">
		<Button label={$t('library.product.download')} selected={selected && selectedButton === 0} {pressed} />
		<Button label={$t('library.product.play')} selected={selected && selectedButton === 1} {pressed} />
	</div>
</Row>
