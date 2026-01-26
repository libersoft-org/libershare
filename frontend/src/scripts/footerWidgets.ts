// Footer position type
export type FooterPosition = 'left' | 'center' | 'right';
// Footer widget definitions
export type FooterWidget = 'version' | 'download' | 'upload' | 'cpu' | 'ram' | 'storage' | 'backendStatus' | 'lishStatus' | 'connection' | 'volume' | 'clock';
export const footerWidgets: FooterWidget[] = ['version', 'download', 'upload', 'cpu', 'ram', 'storage', 'backendStatus', 'lishStatus', 'connection', 'volume', 'clock'];
export const defaultWidgetVisibility: Record<FooterWidget, boolean> = {
	version: false,
	download: true,
	upload: true,
	cpu: false,
	ram: false,
	storage: false,
	backendStatus: true,
	lishStatus: true,
	connection: true,
	volume: true,
	clock: true,
};

/**
 * Get localized label for a footer widget
 */
export function getWidgetLabel(
	widget: FooterWidget,
	t: {
		common?: { version?: string };
		settings?: {
			footerWidgets?: {
				downloads?: string;
				uploads?: string;
				cpu?: string;
				ram?: string;
				storage?: string;
				backendStatus?: string;
				lishStatus?: string;
				connection?: string;
				volume?: string;
				clock?: string;
			};
		};
	}
): string {
	const labels: Record<FooterWidget, string | undefined> = {
		version: t.common?.version,
		download: t.settings?.footerWidgets?.downloads,
		upload: t.settings?.footerWidgets?.uploads,
		cpu: t.settings?.footerWidgets?.cpu,
		ram: t.settings?.footerWidgets?.ram,
		storage: t.settings?.footerWidgets?.storage,
		backendStatus: t.settings?.footerWidgets?.backendStatus,
		lishStatus: t.settings?.footerWidgets?.lishStatus,
		connection: t.settings?.footerWidgets?.connection,
		volume: t.settings?.footerWidgets?.volume,
		clock: t.settings?.footerWidgets?.clock,
	};
	return labels[widget] ?? widget;
}

// ============================================================================
// Connection Widget Logic
// ============================================================================

export type ConnectionType = 'ethernet' | 'wifi';

/**
 * Calculate how many signal bars should be active (0-4)
 */
export function getActiveBars(signalStrength: number, connected: boolean): number {
	if (!connected) return 0;
	if (signalStrength >= 75) return 4;
	if (signalStrength >= 50) return 3;
	if (signalStrength >= 25) return 2;
	return 1;
}

/**
 * Get bar color based on signal strength
 */
export function getBarColor(barIndex: number, activeBars: number): string {
	if (barIndex >= activeBars) return 'var(--secondary-softer-background)';
	if (activeBars === 1) return 'var(--color-error)'; // < 25%
	if (activeBars === 2 || activeBars === 3) return 'var(--color-warning)'; // 25-74%
	return 'var(--color-success)'; // 75%+
}

// ============================================================================
// Footer Widget Configuration
// ============================================================================

/**
 * Widget configuration for Footer component.
 * Maps widget IDs to their component types and default props.
 */
export interface FooterWidgetConfig {
	id: FooterWidget;
	componentType: 'item' | 'bar' | 'clock' | 'lishStatus' | 'backendStatus' | 'connection';
}

export const FOOTER_WIDGET_CONFIGS: FooterWidgetConfig[] = [
	{ id: 'version', componentType: 'item' },
	{ id: 'download', componentType: 'item' },
	{ id: 'upload', componentType: 'item' },
	{ id: 'cpu', componentType: 'bar' },
	{ id: 'ram', componentType: 'bar' },
	{ id: 'storage', componentType: 'bar' },
	{ id: 'backendStatus', componentType: 'backendStatus' },
	{ id: 'lishStatus', componentType: 'lishStatus' },
	{ id: 'connection', componentType: 'connection' },
	{ id: 'volume', componentType: 'item' },
	{ id: 'clock', componentType: 'clock' },
];

/**
 * Get volume icon name based on volume level
 */
export function getVolumeIcon(volume: number): string {
	if (volume === 0) return 'volume0';
	if (volume < 25) return 'volume1';
	if (volume < 75) return 'volume2';
	return 'volume3';
}
