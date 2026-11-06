import { translateError, tt } from './language.ts';
import { addNotification } from './notifications.ts';

/**
 * Copy text to clipboard. If `successMessage` is provided, shows a success notification on success.
 * Errors are always shown as error notifications.
 */
export async function copyToClipboard(text: string, successMessage?: string): Promise<void> {
	try {
		// The Clipboard API exists only in a secure context; a page served over plain HTTP (e.g. on a LAN) falls back to execCommand.
		if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
		else if (!copyWithExecCommand(text)) throw new Error(tt('common.copyFailed'));
		if (successMessage !== undefined) addNotification(successMessage, 'success');
	} catch (e: any) {
		addNotification(translateError(e), 'error');
	}
}

function copyWithExecCommand(text: string): boolean {
	const area = document.createElement('textarea');
	area.value = text;
	area.setAttribute('readonly', '');
	area.style.position = 'fixed';
	area.style.opacity = '0';
	document.body.appendChild(area);
	area.select();
	try {
		return document.execCommand('copy');
	} catch {
		return false;
	} finally {
		area.remove();
	}
}
