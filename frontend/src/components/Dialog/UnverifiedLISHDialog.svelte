<script lang="ts">
	import { t } from '../../scripts/language.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { unverifiedQuestionKey, type UnverifiedOffer } from '../../scripts/lishVerification.ts';
	import ConfirmDialog from './ConfirmDialog.svelte';
	interface Props {
		/** The LISH the question is about. */
		offer: UnverifiedOffer;
		/** Replaces the question for one LISH, e.g. when the answer covers several at once. */
		message?: string | undefined;
		position: Position;
		onAccept: () => void;
		onRefuse: () => void;
	}
	let { offer, message, position, onAccept, onRefuse }: Props = $props();
</script>

<!-- "No" is the default button: adding something unverified takes a deliberate move. -->
<ConfirmDialog title={$t('lish.unverified.title')} message={message ?? $t(unverifiedQuestionKey(offer), { name: offer.name })} confirmLabel={$t('common.yes')} cancelLabel={$t('common.no')} confirmIcon="/img/check.svg" cancelIcon="/img/cross.svg" {position} onConfirm={onAccept} onBack={onRefuse} />
