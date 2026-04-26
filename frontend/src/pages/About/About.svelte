<script lang="ts">
	import { productName, productVersion, productGithub, productWebsite } from '@shared';
	import { buildDate, commitHash } from '../../scripts/app.ts';
	import { t } from '../../scripts/language.ts';
	import { LAYOUT, type Position } from '../../scripts/navigationLayout.ts';
	import { openExternalURL } from '../../scripts/utils.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import Dialog from '../../components/Dialog/Dialog.svelte';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		onBack?: (() => void) | undefined;
	}
	let { areaID, position = LAYOUT.content, onBack }: Props = $props();

	createNavArea(() => ({
		areaID,
		position,
		activate: true,
		trap: true,
		initialPosition: [0, 2],
		onBack,
	}));
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
			<span class="label">{$t('common.version')}:</span>
			<span class="value">{productVersion}</span>
		</div>
		<div class="row">
			<span class="label">{$t('about.buildDate')}:</span>
			<span class="value">{buildDate}</span>
		</div>
		<div class="row">
			<span class="label">{$t('about.commit')}:</span>
			<span class="value">{commitHash}</span>
		</div>
	</div>
	<div class="links">
		<ButtonBar direction="column" gap="1vh">
			<Button icon="/img/github.svg" label={$t('about.githubPage')} position={[0, 0]} padding="1vh" width="20vh" fontSize="1.4vh" borderRadius="1vh" onConfirm={() => openExternalURL(productGithub)} />
			<Button icon="/img/online.svg" label={$t('about.officialWebsite')} position={[0, 1]} padding="1vh" width="20vh" fontSize="1.4vh" borderRadius="1vh" onConfirm={() => openExternalURL(productWebsite)} />
			<Button icon="/img/check.svg" label={$t('common.ok')} position={[0, 2]} width="20vh" onConfirm={onBack} />
		</ButtonBar>
	</div>
</Dialog>
