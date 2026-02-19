import { wsClient } from './ws-client.ts';
import { Api } from '@shared';
export const api = new Api(wsClient);
