import { writable, get } from 'svelte/store';
import { notificationTimeout } from './settings.ts';

export type NotificationType = 'info' | 'success' | 'error' | 'warning';

export interface Notification {
	id: number;
	text: string;
	type: NotificationType;
}
let nextID = 0;
export const notifications = writable<Notification[]>([]);

export function addNotification(text: string, type: NotificationType = 'info'): void {
	const id = nextID++;
	notifications.update(list => [...list, { id, text, type }]);
	const seconds = get(notificationTimeout);
	if (seconds > 0) setTimeout(() => removeNotification(id), seconds * 1000);
}

export function removeNotification(id: number): void {
	notifications.update(list => list.filter(n => n.id !== id));
}
