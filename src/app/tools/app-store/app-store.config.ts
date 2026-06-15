import { IMenuItem } from '../../configs/menu.config';

export interface AppItem extends IMenuItem {
  id: string;
  description?: string;
  enabled?: boolean;
}

// 默认的 App 列表，前6个会显示在 header 上
export const APP_LIST: AppItem[] = [
  {
    id: 'code-viewer',
    name: 'MENU.CODE',
    description: 'APP_STORE.CODE_DESC',
    action: 'tool-open',
    data: { type: 'tool', data: 'code-viewer' },
    icon: 'fa-light fa-rectangle-code',
    router: ['/main/blockly-editor'],
    enabled: true
  },
  {
    id: 'lib-manager',
    name: 'MENU.LIB_MANAGER',
    description: 'APP_STORE.LIB_MANAGER_DESC',
    action: 'tool-open',
    data: { type: 'tool', data: 'lib-manager' },
    icon: 'fa-light fa-books',
    router: ['/main/code-editor'],
    enabled: true
  },
  {
    id: 'serial-monitor',
    name: 'MENU.TOOL_SERIAL',
    description: 'APP_STORE.SERIAL_DESC',
    action: 'tool-open',
    data: { type: 'tool', data: 'serial-monitor' },
    icon: 'fa-light fa-monitor-waveform',
    enabled: true
  },
  {
    id: 'user-center',
    name: 'MENU.USER_AUTH',
    description: 'APP_STORE.USER_CENTER_DESC',
    action: 'tool-open',
    data: { type: 'tool', data: 'user-center' },
    icon: 'fa-light fa-user',
    enabled: true
  },
  {
    id: 'simulator',
    name: 'MENU.SIMULATOR',
    description: 'APP_STORE.SIMULATOR_DESC',
    action: 'tool-open',
    data: { type: 'tool', data: 'simulator' },
    icon: 'fa-light fa-atom',
    router: ['/main/blockly-editor'],
    dev: true,
    enabled: false
  }
];

// Header 上显示的 app 数量上限
export const HEADER_APP_LIMIT = 6;

// Sidebar 上显示的 app 数量上限
export const SIDEBAR_APP_LIMIT = 4;
