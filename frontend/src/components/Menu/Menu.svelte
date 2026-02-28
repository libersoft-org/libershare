<script lang="ts">
	import { type Position } from '../../scripts/navigationLayout.ts';
	import MenuTitle from './MenuTitle.svelte';
	import MenuBar from './MenuBar.svelte';
	import ButtonsGroup from '../Buttons/ButtonsGroup.svelte';
	import Button from '../Buttons/Button.svelte';
	interface Props {
		areaID: string;
		title: string;
		items: Array<{ id: string; label: string; icon?: string | undefined; selected?: boolean | undefined; iconPosition?: 'left' | 'top' | undefined; iconSize?: string | undefined; noColorFilter?: boolean | undefined }>;
		orientation?: 'horizontal' | 'vertical' | undefined;
		selectedId?: string | undefined;
		buttonWidth?: string | undefined;
		position: Position;
		onselect?: ((id: string) => void) | undefined;
		onBack?: (() => void) | undefined;
	}
	let { areaID, title, items, orientation = 'horizontal', selectedId, buttonWidth, position, onselect, onBack }: Props = $props();
	let initialIndex = $derived(
		selectedId
			? Math.max(
					0,
					items.findIndex(i => i.id === selectedId)
				)
			: 0
	);
</script>

<style>
	.menu {
		width: 100%;
		height: 100%;
		/*flex: 1;*/
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		box-sizing: border-box;
		overflow: hidden;
	}
</style>

<div class="menu">
	<MenuTitle {title} />
	<MenuBar>
		{#key `${title}-${selectedId}-${orientation}`}
			<ButtonsGroup {areaID} {position} {initialIndex} {orientation} {onBack}>
				{#each items as item (item.id)}
					{@const showCheckAsIcon = item.selected && !item.icon}
					{@const iconToShow = showCheckAsIcon ? '/img/check.svg' : item.icon}
					{@const badgeToShow = item.selected && item.icon ? '/img/check.svg' : undefined}
					<Button label={item.label} icon={iconToShow} iconPosition={item.iconPosition ?? 'top'} iconSize={item.iconSize ?? '6vh'} noColorFilter={showCheckAsIcon ? false : item.noColorFilter} badgeIcon={badgeToShow} width={buttonWidth} onConfirm={() => onselect?.(item.id)} />
				{/each}
			</ButtonsGroup>
		{/key}
	</MenuBar>
</div>
