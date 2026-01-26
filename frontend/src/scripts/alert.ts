export type AlertType = 'error' | 'warning' | 'info';
export interface AlertConfig {
	icon: string;
	color: string;
}
export const alertAppearance: Record<AlertType, AlertConfig> = {
	error: { icon: '/img/error.svg', color: '--color-error' },
	warning: { icon: '/img/warning.svg', color: '--color-warning' },
	info: { icon: '/img/info.svg', color: '--color-success' },
};
