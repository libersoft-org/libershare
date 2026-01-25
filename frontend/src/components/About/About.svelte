<script lang="ts">
	import { productName, productVersion, buildDate, commitHash } from '../../scripts/app.ts';
	import { t } from '../../scripts/language.ts';
	import { LAYOUT, type Position } from '../../scripts/navigationLayout.ts';
	import Dialog from '../Dialog/Dialog.svelte';
	import ButtonsGroup from '../Buttons/ButtonsGroup.svelte';
	import Button from '../Buttons/Button.svelte';
	interface Props {
		areaID: string;
		position?: Position;
		onBack?: () => void;
	}
	let { areaID, position = LAYOUT.content, onBack }: Props = $props();

	function openUrl(url: string) {
		window.open(url, '_blank');
	}
</script>

<style>
	.build {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 1vh;
		font-size: 2vh;
	}

	.build .row {
		display: flex;
		gap: 1vh;
	}

	.build .row .label {
		color: var(--disabled-foreground);
	}

	.links {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 1vh;
		margin-top: 2vh;
	}
</style>

<Dialog title={productName}>
	<div class="build">
		<div class="row">
			<span class="label">{$t.common?.version}:</span>
			<span class="value">{productVersion}</span>
		</div>
		<div class="row">
			<span class="label">{$t.about?.buildDate}:</span>
			<span class="value">{buildDate}</span>
		</div>
		<div class="row">
			<span class="label">{$t.about?.commit}:</span>
			<span class="value">{commitHash}</span>
		</div>
	</div>
	<div class="links">
		<ButtonsGroup {areaID} {position} initialIndex={2} {onBack}>
			<Button label={$t.about?.githubPage} padding="1vh" fontSize="1.4vh" borderRadius="1vh" onConfirm={() => openUrl('https://github.com/libersoft-org/libershare')} />
			<Button label={$t.about?.officialWebsite} padding="1vh" fontSize="1.4vh" borderRadius="1vh" onConfirm={() => openUrl('https://libershare.com')} />
			<Button label={$t.common?.ok} onConfirm={onBack} />
		</ButtonsGroup>
	</div>
</Dialog>
