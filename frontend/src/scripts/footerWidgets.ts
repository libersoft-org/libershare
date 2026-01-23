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
