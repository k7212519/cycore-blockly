import type {
  ComponentConfig,
  ConfigPin,
  ConnectionGraphPayload,
  FunctionTypeDef,
} from './connection-graph.service';

export const CYCORE_ESP32S3_PINMAP_ID = 'cycore-esp32s3-devkitc1-n16r8';
export const CYCORE_ESP32S3_DOC_URL =
  'https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32s3/esp32-s3-devkitc-1/user_guide_v1.1.html';

const functionTypes: FunctionTypeDef[] = [
  { value: 'power', label: 'Power', color: '#EF4444', textColor: '#FFFFFF' },
  { value: 'gnd', label: 'GND', color: '#111827', textColor: '#FFFFFF' },
  { value: 'gpio', label: 'GPIO', color: '#3B82F6', textColor: '#FFFFFF' },
  { value: 'adc', label: 'ADC', color: '#10B981', textColor: '#FFFFFF' },
  { value: 'touch', label: 'Touch', color: '#8B5CF6', textColor: '#FFFFFF' },
  { value: 'uart', label: 'UART', color: '#F59E0B', textColor: '#111827' },
  { value: 'spi', label: 'SPI', color: '#EC4899', textColor: '#FFFFFF' },
  { value: 'usb', label: 'USB', color: '#06B6D4', textColor: '#111827' },
  { value: 'led', label: 'LED', color: '#F97316', textColor: '#FFFFFF' },
  { value: 'reset', label: 'Reset', color: '#64748B', textColor: '#FFFFFF' },
];

const boardSvg = encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="720" height="360" viewBox="0 0 720 360">
  <rect width="720" height="360" rx="34" fill="#182033"/>
  <rect x="176" y="58" width="368" height="244" rx="26" fill="#243047" stroke="#53647D" stroke-width="3"/>
  <rect x="252" y="98" width="216" height="124" rx="20" fill="#111827" stroke="#8BDCF1" stroke-width="4"/>
  <text x="360" y="151" text-anchor="middle" font-family="Arial, sans-serif" font-size="30" font-weight="700" fill="#E5F9FF">ESP32-S3</text>
  <text x="360" y="188" text-anchor="middle" font-family="Arial, sans-serif" font-size="20" fill="#9FB5C9">N16R8 Dev Board</text>
  <rect x="268" y="250" width="74" height="28" rx="9" fill="#36445D"/>
  <rect x="378" y="250" width="74" height="28" rx="9" fill="#36445D"/>
  <text x="305" y="269" text-anchor="middle" font-family="Arial, sans-serif" font-size="13" fill="#CFE9F5">USB</text>
  <text x="415" y="269" text-anchor="middle" font-family="Arial, sans-serif" font-size="13" fill="#CFE9F5">UART</text>
  <circle cx="490" cy="80" r="8" fill="#7DD3FC"/>
  <text x="490" y="106" text-anchor="middle" font-family="Arial, sans-serif" font-size="12" fill="#AFC4D9">RGB</text>
</svg>
`);

function pinFunctions(name: string) {
  if (name === '3V3') return [{ name: '3V3', type: 'power' }];
  if (name === '5V') return [{ name: '5V', type: 'power' }];
  if (name === 'G') return [{ name: 'GND', type: 'gnd' }];
  if (name === 'RST') return [{ name: 'EN', type: 'reset' }];
  if (name === 'TX') return [{ name: 'TX', type: 'uart' }, { name: 'GPIO43', type: 'gpio' }];
  if (name === 'RX') return [{ name: 'RX', type: 'uart' }, { name: 'GPIO44', type: 'gpio' }];

  const gpio = `GPIO${name}`;
  const functions = [{ name: gpio, type: 'gpio' }];
  const adcMap: Record<string, string> = {
    '1': 'ADC1_CH0',
    '2': 'ADC1_CH1',
    '3': 'ADC1_CH2',
    '4': 'ADC1_CH3',
    '5': 'ADC1_CH4',
    '6': 'ADC1_CH5',
    '7': 'ADC1_CH6',
    '8': 'ADC1_CH7',
    '9': 'ADC1_CH8',
    '10': 'ADC1_CH9',
    '11': 'ADC2_CH0',
    '12': 'ADC2_CH1',
    '13': 'ADC2_CH2',
    '14': 'ADC2_CH3',
    '15': 'ADC2_CH4',
    '16': 'ADC2_CH5',
    '17': 'ADC2_CH6',
    '18': 'ADC2_CH7',
    '19': 'ADC2_CH8',
    '20': 'ADC2_CH9',
  };
  const touchMap = new Set(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15', '16', '17', '18', '19', '20', '21']);
  if (adcMap[name]) functions.push({ name: adcMap[name], type: 'adc' });
  if (touchMap.has(name)) functions.push({ name: `TOUCH${name}`, type: 'touch' });
  if (['9', '10', '11', '12', '13', '14', '35', '36', '37', '38', '39'].includes(name)) {
    functions.push({ name: 'SPI', type: 'spi' });
  }
  if (name === '17') functions.push({ name: 'U1TXD', type: 'uart' });
  if (name === '18') functions.push({ name: 'U1RXD', type: 'uart' });
  if (name === '19') functions.push({ name: 'USB_D-', type: 'usb' });
  if (name === '20') functions.push({ name: 'USB_D+', type: 'usb' });
  if (name === '38') functions.push({ name: 'RGB LED', type: 'led' });
  return functions;
}

function buildPin(name: string, index: number, side: 'left' | 'right'): ConfigPin {
  const y = 20 + index * 15;
  const id = side === 'left' ? `J1-${index + 1}-${name}` : `J3-${index + 1}-${name}`;
  const isReserved = ['35', '36', '37'].includes(name);
  return {
    id,
    x: side === 'left' ? 118 : 602,
    y,
    labelX: side === 'left' ? 88 : 632,
    labelY: y,
    layout: 'horizontal',
    labelAnchor: side === 'left' ? 'right' : 'left',
    visible: true,
    disabled: isReserved,
    functions: pinFunctions(name).map(fn => ({
      ...fn,
      disabled: isReserved,
    })),
  };
}

const j1Pins = ['3V3', '3V3', 'RST', '4', '5', '6', '7', '15', '16', '17', '18', '8', '3', '46', '9', '10', '11', '12', '13', '14', '5V', 'G'];
const j3Pins = ['G', 'TX', 'RX', '1', '2', '42', '41', '40', '39', '38', '37', '36', '35', '0', '45', '48', '47', '21', '20', '19', 'G', 'G'];

export function isCycoreEsp32S3Board(board: unknown): boolean {
  const text = typeof board === 'string'
    ? board
    : JSON.stringify(board || {});
  const normalized = text.toLowerCase().replace(/[^a-z0-9]/g, '');
  return normalized.includes('cycoreesp32s3') ||
    normalized.includes('esp32s3n16r8') ||
    normalized.includes('wifiduinoesp32s3dev') ||
    normalized.includes('boardesp32s3dev');
}

export function getCycoreEsp32S3Pinmap(): ComponentConfig {
  return {
    id: CYCORE_ESP32S3_PINMAP_ID,
    name: 'Cycore ESP32S3',
    width: 720,
    height: 360,
    images: [{
      url: `data:image/svg+xml;charset=utf-8,${boardSvg}`,
      x: 0,
      y: 0,
      width: 720,
      height: 360,
    }],
    pins: [
      ...j1Pins.map((name, index) => buildPin(name, index, 'left')),
      ...j3Pins.map((name, index) => buildPin(name, index, 'right')),
    ],
    functionTypes,
  };
}

export function getCycoreEsp32S3DocUrl(): string {
  return CYCORE_ESP32S3_DOC_URL;
}

export function buildEmptyCycoreConnectionPayload(theme: 'light' | 'dark'): ConnectionGraphPayload {
  const boardConfig = getCycoreEsp32S3Pinmap();
  const refId = 'cycore_esp32s3';
  return {
    componentConfigs: {
      [refId]: boardConfig,
    },
    components: [{
      refId,
      componentId: boardConfig.id,
      componentName: boardConfig.name,
      pinmapId: 'board-cycore-esp32s3:devkitc1-n16r8:default',
      instance: 0,
      componentType: 'hardware',
    }],
    connections: [],
    theme,
  };
}
