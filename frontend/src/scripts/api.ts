import { wsClient } from './ws-client.ts';
import { API } from '@shared';
export const api = new API(wsClient);
