import { IMenuItem } from '../../../../configs/menu.config';

const NEW_FILE_MENU_ITEM: IMenuItem = {
  name: 'MENU.FOLDER_NEW_FILE',
  action: 'folder-new-file',
  icon: 'fa-light fa-file-plus',
  type: 'folder'
};

const NEW_FOLDER_MENU_ITEM: IMenuItem = {
  name: 'MENU.FOLDER_NEW_FOLDER',
  action: 'folder-new-folder',
  icon: 'fa-light fa-folder-plus',
  type: 'folder'
};

const UPLOAD_MENU_ITEM: IMenuItem = {
  name: 'MENU.FOLDER_UPLOAD_FILES',
  action: 'folder-upload-files',
  icon: 'fa-light fa-upload',
  type: 'folder'
};

const FILE_RENAME_MENU_ITEM: IMenuItem = {
  name: 'MENU.FILE_RENAME',
  action: 'file-rename',
  icon: 'fa-light fa-pen',
  type: 'file'
};

const FILE_DELETE_MENU_ITEM: IMenuItem = {
  name: 'MENU.FILE_DELETE',
  action: 'file-delete',
  icon: 'fa-light fa-trash',
  type: 'file',
  color: '#ff4d4f'
};

const FOLDER_RENAME_MENU_ITEM: IMenuItem = {
  name: 'MENU.FOLDER_RENAME',
  action: 'folder-rename',
  icon: 'fa-light fa-pen',
  type: 'folder'
};

const FOLDER_DELETE_MENU_ITEM: IMenuItem = {
  name: 'MENU.FOLDER_DELETE',
  action: 'folder-delete',
  icon: 'fa-light fa-trash',
  type: 'folder',
  color: '#ff4d4f'
};

const MULTI_DELETE_MENU_ITEM: IMenuItem = {
  name: 'MENU.MULTI_DELETE',
  action: 'multi-delete',
  icon: 'fa-light fa-trash',
  type: 'multi',
  color: '#ff4d4f'
};

export const FILE_RIGHTCLICK_MENU: IMenuItem[] = [
  UPLOAD_MENU_ITEM,
  { sep: true },
  FILE_RENAME_MENU_ITEM,
  FILE_DELETE_MENU_ITEM
];

export const FOLDER_RIGHTCLICK_MENU: IMenuItem[] = [
  NEW_FILE_MENU_ITEM,
  NEW_FOLDER_MENU_ITEM,
  UPLOAD_MENU_ITEM,
  { sep: true },
  FOLDER_RENAME_MENU_ITEM,
  FOLDER_DELETE_MENU_ITEM
];

export const ROOT_RIGHTCLICK_MENU: IMenuItem[] = [
  NEW_FILE_MENU_ITEM,
  NEW_FOLDER_MENU_ITEM,
  UPLOAD_MENU_ITEM
];

export const MULTI_SELECT_MENU: IMenuItem[] = [MULTI_DELETE_MENU_ITEM];
