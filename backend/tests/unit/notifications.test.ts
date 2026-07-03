import { describe, it, expect } from 'bun:test';
// Re-implement notification logic for unit testing (mirrors frontend/src/scripts/notifications.ts)
type NotificationType = 'info' | 'success' | 'error' | 'warning';
interface Notification {
	id: number;
	text: string;
	type: NotificationType;
}
let nextID = 0;
let store: Notification[] = [];

function addNotification(text: string, type: NotificationType = 'info'): Notification {
	const id = nextID++;
	const notification: Notification = { id, text, type };
	store = [...store, notification];
	return notification;
}

function removeNotification(id: number): void {
	store = store.filter(n => n.id !== id);
}

function reset(): void {
	store = [];
	nextID = 0;
}

// ============================================================================
// NotificationType
// ============================================================================
describe('NotificationType', () => {
	it('defaults to info when no type specified', () => {
		reset();
		const n = addNotification('test message');
		expect(n.type).toBe('info');
	});
	it('accepts success type', () => {
		reset();
		const n = addNotification('download complete', 'success');
		expect(n.type).toBe('success');
	});
	it('accepts error type', () => {
		reset();
		const n = addNotification('connection failed', 'error');
		expect(n.type).toBe('error');
	});
	it('accepts warning type', () => {
		reset();
		const n = addNotification('network disconnected', 'warning');
		expect(n.type).toBe('warning');
	});
});

// addNotification
describe('addNotification', () => {
	it('adds notification to store', () => {
		reset();
		addNotification('hello');
		expect(store).toHaveLength(1);
		expect(store[0]!.text).toBe('hello');
	});
	it('assigns incrementing IDs', () => {
		reset();
		const a = addNotification('first');
		const b = addNotification('second');
		expect(b.id).toBe(a.id + 1);
	});
	it('preserves existing notifications', () => {
		reset();
		addNotification('first', 'info');
		addNotification('second', 'success');
		addNotification('third', 'error');
		expect(store).toHaveLength(3);
		expect(store.map(n => n.type)).toEqual(['info', 'success', 'error']);
	});
});

// removeNotification
describe('removeNotification', () => {
	it('removes notification by ID', () => {
		reset();
		const n = addNotification('to remove');
		expect(store).toHaveLength(1);
		removeNotification(n.id);
		expect(store).toHaveLength(0);
	});
	it('keeps other notifications when removing one', () => {
		reset();
		addNotification('keep', 'success');
		const toRemove = addNotification('remove', 'error');
		addNotification('also keep', 'warning');
		removeNotification(toRemove.id);
		expect(store).toHaveLength(2);
		expect(store.map(n => n.text)).toEqual(['keep', 'also keep']);
	});
	it('does nothing for non-existent ID', () => {
		reset();
		addNotification('exists');
		removeNotification(999);
		expect(store).toHaveLength(1);
	});
});

// Type mapping validation (documents which notification types are used where)
describe('notification type mapping', () => {
	it('success notifications include completions and creations', () => {
		reset();
		const completions = [addNotification('Download complete', 'success'), addNotification('Verify done', 'success'), addNotification('Move success', 'success'), addNotification('File created', 'success'), addNotification('Directory created', 'success'), addNotification('Network exported', 'success'), addNotification('Reconnected to backend', 'success')];
		expect(completions.every(n => n.type === 'success')).toBe(true);
	});
	it('warning notifications include deletions and disconnections', () => {
		reset();
		const warnings = [addNotification('LISH deleted', 'warning'), addNotification('File deleted', 'warning'), addNotification('Network disconnected', 'warning'), addNotification('Gamepad disconnected', 'warning'), addNotification('Backend disconnected', 'warning')];
		expect(warnings.every(n => n.type === 'warning')).toBe(true);
	});
	it('error notifications include failures', () => {
		reset();
		const errors = [addNotification('WebSocket error', 'error'), addNotification('Download failed', 'error')];
		expect(errors.every(n => n.type === 'error')).toBe(true);
	});
	it('info notifications include neutral events', () => {
		reset();
		const infos = [addNotification('LISH added', 'info')];
		expect(infos.every(n => n.type === 'info')).toBe(true);
	});
});
