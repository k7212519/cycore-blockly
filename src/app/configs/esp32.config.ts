import { IMenuItem } from "./menu.config";

export let ESP32_CONFIG_MENU: IMenuItem[] = [
    {
        sep: true,
    },
    {
        name: 'ESP32.UPLOAD_SPEED',
        data: {},
        icon: "fa-light fa-up-from-line",
        children: []
    },
    {
        name: 'ESP32.UPLOAD_MODE',
        data: {},
        icon: "fa-light fa-cloud-arrow-up",
        children: []
    },
    {
        name: 'ESP32.AFTER_UPLOAD',
        data: {},
        icon: "fa-light fa-rotate-right",
        children: []
    },
    {
        name: 'ESP32.FLASH_MODE',
        data: {},
        icon: 'fa-light fa-tablet-rugged',
        children: []
    },
    {
        name: 'ESP32.FLASH_FREQ',
        data: {},
        icon: 'fa-light fa-wave-square',
        children: []
    },
    {
        name: 'ESP32.FLASH_SIZE',
        data: {},
        icon: "fa-light fa-database",
        children: []
    },
    {
        name: 'ESP32.PARTITION_SCHEME',
        data: {},
        icon: "fa-light fa-hard-drive",
        children: []
    },
    {
        name: 'ESP32.CDC_ON_BOOT',
        data: {},
        icon: "fa-brands fa-usb",
        children: []
    },
    {
        name: 'ESP32.PSRAM',
        data: {},
        icon: "fa-light fa-memory",
        children: []
    },
    {
        name: 'ESP32.ERASE_FLASH',
        data: {},
        icon: "fa-light fa-eraser",
        children: []
    },
    {
        name: 'ESP32.COMPRESS_UPLOAD',
        data: {},
        icon: "fa-light fa-file-zipper",
        children: []
    }
]
