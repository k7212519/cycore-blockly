'use strict';

const SUPPORTED_BAUDRATES = [115200, 230400, 460800, 921600, 1500000, 2000000];
const DEFAULT_FLASH_BAUD = 921600;

const USB_BRIDGE_CAPABILITIES = {
  0x1a86: {
    vendorName: 'QinHeng Electronics',
    products: {
      0x7522: { name: 'CH340', maxBaudrate: 460800 },
      0x7523: { name: 'CH340', maxBaudrate: 460800 },
      0x7584: { name: 'CH340', maxBaudrate: 460800 },
      0x5523: { name: 'CH341', maxBaudrate: 2000000 },
      0x55d3: { name: 'CH343', maxBaudrate: 6000000 },
      0x55d4: { name: 'CH9102', maxBaudrate: 6000000 },
      0x55d8: { name: 'CH9101', maxBaudrate: 3000000 }
    }
  },
  0x10c4: {
    vendorName: 'Silicon Labs',
    products: {
      0xea60: { name: 'CP2102(n)', maxBaudrate: 3000000 },
      0xea70: { name: 'CP2105', maxBaudrate: 2000000 },
      0xea71: { name: 'CP2108', maxBaudrate: 2000000 }
    }
  },
  0x0403: {
    vendorName: 'FTDI',
    products: {
      0x6001: { name: 'FT232R', maxBaudrate: 3000000 },
      0x6010: { name: 'FT2232', maxBaudrate: 3000000 },
      0x6011: { name: 'FT4232', maxBaudrate: 3000000 },
      0x6014: { name: 'FT232H', maxBaudrate: 12000000 },
      0x6015: { name: 'FT230X', maxBaudrate: 3000000 }
    }
  },
  0x303a: {
    vendorName: 'Espressif Systems',
    products: {
      0x0002: { name: 'ESP32-S2 Native USB', maxBaudrate: 2000000 },
      0x1000: { name: 'ESP32 Native USB', maxBaudrate: 2000000 },
      0x1001: { name: 'ESP32 Native USB', maxBaudrate: 2000000 },
      0x1002: { name: 'ESP32 Native USB', maxBaudrate: 2000000 },
      0x4002: { name: 'ESP32 Native USB (CDC)', maxBaudrate: 2000000 }
    }
  }
};

function parseUsbId(raw) {
  if (raw == null) return undefined;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  const text = String(raw).trim().replace(/^0x/i, '');
  if (!text) return undefined;
  const value = parseInt(text, 16);
  return Number.isFinite(value) ? value : undefined;
}

function getUsbDeviceInfo(vid, pid) {
  const vendor = USB_BRIDGE_CAPABILITIES[vid];
  if (!vendor) return undefined;
  const product = vendor.products[pid];
  if (!product) return { vendorName: vendor.vendorName };
  return {
    vendorName: vendor.vendorName,
    productName: product.name,
    maxBaudrate: product.maxBaudrate
  };
}

async function lookupBridgeByPath(portPath) {
  if (!portPath) return {};
  try {
    const serialport = require('serialport');
    const SerialPort = serialport.SerialPort || serialport;
    const ports = await SerialPort.list();
    const entry = ports.find(port => port.path === portPath);
    if (!entry) return {};
    const vid = parseUsbId(entry.vendorId);
    const pid = parseUsbId(entry.productId);
    if (vid === undefined || pid === undefined) return { vid, pid };
    return { vid, pid, bridge: getUsbDeviceInfo(vid, pid) };
  } catch {
    return {};
  }
}

function capBaudrate(userBaud, bridge) {
  const requested = Number(userBaud) || DEFAULT_FLASH_BAUD;
  if (bridge?.maxBaudrate && requested > bridge.maxBaudrate) {
    const capped = SUPPORTED_BAUDRATES.filter(rate => rate <= bridge.maxBaudrate).pop() || DEFAULT_FLASH_BAUD;
    return { baud: capped, capped: true, requested, bridge };
  }
  return { baud: requested, capped: false, requested, bridge };
}

async function resolveDesiredBaud(portPath, userBaud) {
  const { bridge } = await lookupBridgeByPath(portPath);
  return capBaudrate(userBaud, bridge);
}

module.exports = {
  DEFAULT_FLASH_BAUD,
  getUsbDeviceInfo,
  lookupBridgeByPath,
  resolveDesiredBaud
};
