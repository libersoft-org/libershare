// Footer position type
export type FooterPosition = 'left' | 'center' | 'right';
// Footer widget definitions
export type FooterWidget = 'version' | 'lishStatus' | 'download' | 'upload' | 'cpu' | 'ram' | 'storage' | 'volume' | 'clock';
export const footerWidgets: FooterWidget[] = ['version', 'lishStatus', 'download', 'upload', 'cpu', 'ram', 'storage', 'volume', 'clock'];
export const defaultWidgetVisibility: Record<FooterWidget, boolean> = {
	version: false,
	lishStatus: true,
	download: true,
	upload: true,
	cpu: false,
	ram: false,
	storage: false,
	volume: true,
	clock: true,
};
