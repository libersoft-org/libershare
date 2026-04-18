import { translateError } from './language.ts';
import { addNotification } from './notifications.ts';

/**
 * Copy text to clipboard. If `successMessage` is provided, shows a success notification on success.
 * Errors are always shown as error notifications.
 */
export async function copyToClipboard(text: string, successMessage?: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(text);
		if (successMessage !== undefined) addNotification(successMessage, 'success');
	} catch (e: any) {
		addNotification(translateError(e), 'error');
	}
}
