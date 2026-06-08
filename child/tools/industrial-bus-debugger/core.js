'use strict';

const { TextEncoder } = require('util');

function asError(error) {
  if (!error) return '';
  if (error instanceof Error) return error.message || String(error);
  return String(error);
}

function createLog(direction, protocol, summary, detail = '', hex = '') {
  return { direction, protocol, summary, detail, hex };
}

function parseHexBytes(value) {
  const compact = String(value || '').replace(/0x/gi, '').replace(/[\s,;:_-]/g, '');
  if (!compact) return [];
  if (compact.length % 2 !== 0 || /[^0-9a-f]/i.test(compact)) return null;

  const bytes = [];
  for (let index = 0; index < compact.length; index += 2) {
    bytes.push(Number.parseInt(compact.slice(index, index + 2), 16));
  }
  return bytes;
}

function parseHex(value, protocol, logs, allowEmpty = false) {
  const bytes = parseHexBytes(value);
  if (bytes === null) {
    logs.push(createLog('error', protocol, 'INVALID_HEX', String(value || '')));
    return null;
  }
  if (bytes.length === 0 && !allowEmpty) {
    logs.push(createLog('error', protocol, 'EMPTY_PAYLOAD'));
    return null;
  }
  return bytes;
}

function parseHexNumber(value) {
  const compact = String(value || '').trim().replace(/^0x/i, '');
  if (!compact || /[^0-9a-f]/i.test(compact)) return null;
  return Number.parseInt(compact, 16);
}

function getIntegerInRange(value, min, max, protocol, logs) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < min || parsed > max) {
    logs.push(createLog('error', protocol, 'INVALID_MODBUS_FIELD', `${value} (${min}-${max})`));
    return null;
  }
  return parsed;
}

function isValidCanId(id, format) {
  return id >= 0 && id <= (format === 'standard' ? 0x7ff : 0x1fffffff);
}

function canPassesFilter(id, options = {}) {
  const filterIdText = String(options.canFilterId || options.filterId || '').trim();
  if (!filterIdText) return true;

  const frameFormat = options.canFrameFormat || options.frameFormat || 'standard';
  const filterId = parseHexNumber(filterIdText);
  const mask = parseHexNumber(options.canFilterMask || options.filterMask || (frameFormat === 'standard' ? '7FF' : '1FFFFFFF'));
  if (filterId === null || mask === null) return true;
  return (id & mask) === (filterId & mask);
}

function crc16Modbus(bytes) {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      if ((crc & 0x0001) !== 0) {
        crc = (crc >> 1) ^ 0xa001;
      } else {
        crc >>= 1;
      }
    }
  }
  return crc & 0xffff;
}

function appendModbusCrc(bytes) {
  const crc = crc16Modbus(bytes);
  return [...bytes, crc & 0xff, (crc >> 8) & 0xff];
}

function u16(value) {
  return [(value >> 8) & 0xff, value & 0xff];
}

function clampInteger(value, min, max) {
  const parsed = Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : min;
  return Math.max(min, Math.min(max, parsed));
}

function formatCanId(id, format) {
  return id.toString(16).toUpperCase().padStart(format === 'standard' ? 3 : 8, '0');
}

function formatHex(bytes) {
  return bytes.map(byte => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

function formatCompactHex(bytes) {
  return bytes.map(byte => byte.toString(16).padStart(2, '0').toUpperCase()).join('');
}

function formatRegisterValues(bytes) {
  const values = [];
  for (let index = 0; index < bytes.length; index += 2) {
    const value = (bytes[index] << 8) | bytes[index + 1];
    values.push(`0x${value.toString(16).padStart(4, '0').toUpperCase()}`);
  }
  return values.join(', ');
}

function toAsciiPreview(bytes) {
  return bytes.map(byte => byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.').join('');
}

function parseCanLine(line, options = {}) {
  const canFdEnabled = options.canFdEnabled === true;
  const compactLine = String(line || '').replace(/\s+/g, '');
  const compactMatch = compactLine.match(/^([0-9a-fA-F]{1,8})#([Rr]?[0-9a-fA-F]*)$/);
  if (compactMatch) {
    const id = parseHexNumber(compactMatch[1]);
    if (id === null || id > 0x1fffffff) return null;
    const payload = compactMatch[2];
    const remote = /^[Rr]/.test(payload);
    const dataText = remote ? payload.slice(1) : payload;
    const data = remote ? [] : parseHexBytes(dataText);
    if (data === null) return null;
    const dlc = remote ? clampInteger(Number.parseInt(dataText || '0', 10), 0, canFdEnabled ? 64 : 8) : data.length;
    return {
      id,
      format: id > 0x7ff ? 'extended' : 'standard',
      remote,
      dlc,
      data,
      raw: line
    };
  }

  const candumpMatch = String(line || '').match(/^(?:\S+\s+)?([0-9a-fA-F]{1,8})\s+\[(\d{1,2})\]\s*(.*)$/);
  if (candumpMatch) {
    const id = parseHexNumber(candumpMatch[1]);
    const dlc = Number.parseInt(candumpMatch[2], 10);
    const data = parseHexBytes(candumpMatch[3]);
    if (id === null || data === null || id > 0x1fffffff) return null;
    return {
      id,
      format: id > 0x7ff ? 'extended' : 'standard',
      remote: false,
      dlc,
      data,
      raw: line
    };
  }

  const tokens = String(line || '').split(/[\s,]+/).filter(Boolean);
  if (tokens.length >= 1) {
    const id = parseHexNumber(tokens[0]);
    const data = parseHexBytes(tokens.slice(1).join(' '));
    if (id !== null && data !== null && id <= 0x1fffffff) {
      return {
        id,
        format: id > 0x7ff ? 'extended' : 'standard',
        remote: false,
        dlc: data.length,
        data,
        raw: line
      };
    }
  }

  return null;
}

function getRs485PayloadBytes(value, mode, logs) {
  if (mode === 'hex') {
    return parseHex(value, 'RS485', logs);
  }

  if (!value) {
    logs.push(createLog('error', 'RS485', 'EMPTY_PAYLOAD'));
    return null;
  }
  return Array.from(new TextEncoder().encode(String(value)));
}

function getModbusWriteBytes(functionCode, quantity, options, logs) {
  const parsed = parseHex(options.modbusWriteValue || options.writeValue || '', 'Modbus', logs, true);
  if (parsed === null) return null;

  if (functionCode === 0x05 || functionCode === 0x06) {
    const defaultValue = functionCode === 0x05 ? [0xff, 0x00] : [0x00, 0x01];
    const value = parsed.length === 0 ? defaultValue : parsed;
    if (value.length !== 2) {
      logs.push(createLog('error', 'Modbus', 'MODBUS_WRITE_LENGTH', '2 bytes required'));
      return null;
    }
    return value;
  }

  const requiredLength = functionCode === 0x0f ? Math.ceil(quantity / 8) : quantity * 2;
  const value = parsed.length === 0 ? new Array(requiredLength).fill(0) : parsed;
  if (value.length !== requiredLength) {
    logs.push(createLog('error', 'Modbus', 'MODBUS_WRITE_LENGTH', `${requiredLength} bytes required`));
    return null;
  }
  return value;
}

function buildModbusPdu(options, logs) {
  const functionCode = Number.parseInt(options.modbusFunction || options.functionCode || '03', 16);
  const address = getIntegerInRange(options.modbusAddress ?? options.address ?? 0, 0, 65535, 'Modbus', logs);
  const quantity = getIntegerInRange(options.modbusQuantity ?? options.quantity ?? 2, 1, 2000, 'Modbus', logs);
  if (address === null || quantity === null || Number.isNaN(functionCode)) return null;

  if ([0x01, 0x02, 0x03, 0x04].includes(functionCode)) {
    return [functionCode, ...u16(address), ...u16(quantity)];
  }

  if (functionCode === 0x05 || functionCode === 0x06) {
    const value = getModbusWriteBytes(functionCode, quantity, options, logs);
    if (!value) return null;
    return [functionCode, ...u16(address), ...value];
  }

  if (functionCode === 0x0f || functionCode === 0x10) {
    const value = getModbusWriteBytes(functionCode, quantity, options, logs);
    if (!value) return null;
    return [functionCode, ...u16(address), ...u16(quantity), value.length, ...value];
  }

  logs.push(createLog('error', 'Modbus', 'INVALID_MODBUS_FIELD', `FC${options.modbusFunction || options.functionCode}`));
  return null;
}

function describeModbusPdu(protocol, unitId, pdu, detailPrefix, rawBytes) {
  if (pdu.length < 1) {
    return createLog('error', 'Modbus', 'INVALID_MODBUS_FIELD', 'empty PDU');
  }

  const functionCode = pdu[0];
  if ((functionCode & 0x80) !== 0) {
    const exceptionCode = pdu[1] ?? 0;
    return createLog(
      'error',
      'Modbus',
      'MODBUS_EXCEPTION',
      `unit=${unitId}, fc=0x${(functionCode & 0x7f).toString(16).padStart(2, '0').toUpperCase()}, exception=0x${exceptionCode.toString(16).padStart(2, '0').toUpperCase()}, ${detailPrefix}`,
      formatHex(rawBytes)
    );
  }

  let detail = `unit=${unitId}, ${detailPrefix}`;
  if ([0x01, 0x02, 0x03, 0x04].includes(functionCode) && pdu.length >= 2) {
    const byteCount = pdu[1];
    const data = pdu.slice(2, 2 + byteCount);
    detail += `, byteCount=${byteCount}, data=${formatHex(data)}`;
    if ((functionCode === 0x03 || functionCode === 0x04) && data.length % 2 === 0) {
      detail += `, registers=${formatRegisterValues(data)}`;
    }
  } else if ([0x05, 0x06, 0x0f, 0x10].includes(functionCode) && pdu.length >= 5) {
    const address = (pdu[1] << 8) | pdu[2];
    const value = (pdu[3] << 8) | pdu[4];
    detail += `, address=${address}, value=${value}`;
  }

  return createLog(
    'rx',
    'Modbus',
    `Modbus ${protocol.toUpperCase()} RX FC${functionCode.toString(16).padStart(2, '0').toUpperCase()}`,
    detail,
    formatHex(rawBytes)
  );
}

function parseModbusRtu(bytes) {
  if (bytes.length < 5) {
    return createLog('error', 'Modbus', 'INVALID_MODBUS_FIELD', 'RTU frame too short');
  }

  const frame = bytes.slice(0, -2);
  const actualCrc = bytes[bytes.length - 2] | (bytes[bytes.length - 1] << 8);
  const expectedCrc = crc16Modbus(frame);
  const crcDetail = actualCrc === expectedCrc
    ? 'crc=ok'
    : `crc=bad expected ${formatHex([expectedCrc & 0xff, (expectedCrc >> 8) & 0xff])}`;

  return describeModbusPdu('rtu', frame[0], frame.slice(1), crcDetail, bytes);
}

function parseModbusTcp(bytes) {
  if (bytes.length < 8) {
    return createLog('error', 'Modbus', 'INVALID_MODBUS_FIELD', 'TCP frame too short');
  }

  const transactionId = (bytes[0] << 8) | bytes[1];
  const protocolId = (bytes[2] << 8) | bytes[3];
  const length = (bytes[4] << 8) | bytes[5];
  const unitId = bytes[6];
  const pdu = bytes.slice(7);
  const lengthDetail = length === bytes.length - 6 ? 'length=ok' : `length=bad header=${length} actual=${bytes.length - 6}`;
  const protocolDetail = protocolId === 0 ? 'protocol=0' : `protocol=${protocolId}`;

  return describeModbusPdu('tcp', unitId, pdu, `tid=${transactionId}, ${protocolDetail}, ${lengthDetail}`, bytes);
}

function sendCanFrame(options = {}) {
  const logs = [];
  const frameFormat = options.canFrameFormat || options.frameFormat || 'standard';
  const frameType = options.canFrameType || options.frameType || 'data';
  const id = parseHexNumber(options.canFrameId || options.frameId || '123');

  if (id === null || !isValidCanId(id, frameFormat)) {
    logs.push(createLog('error', 'CAN', 'INVALID_CAN_ID', String(options.canFrameId || options.frameId || '')));
    return { logs };
  }

  const maxBytes = options.canFdEnabled === true ? 64 : 8;
  const remote = frameType === 'remote';
  let data = [];
  let dlc = 0;

  if (remote) {
    dlc = clampInteger(options.canDlc || options.dlc || 0, 0, maxBytes);
  } else {
    const parsed = parseHex(options.canPayload || options.payload || '', 'CAN', logs, true);
    if (parsed === null) return { logs };
    data = parsed;
    dlc = data.length;
    if (data.length > maxBytes) {
      logs.push(createLog('error', 'CAN', 'CAN_PAYLOAD_TOO_LONG', `${data.length}/${maxBytes}`));
      return { logs };
    }
  }

  const idText = formatCanId(id, frameFormat);
  const hex = remote ? `${idText}#R${dlc}` : `${idText}#${formatCompactHex(data)}`;
  const filterText = canPassesFilter(id, options) ? 'filter=pass' : 'filter=skip';

  logs.push(createLog(
    'tx',
    'CAN',
    `CAN TX ${idText} DLC=${dlc}`,
    `${options.canBitrate || options.bitrate || '500000'} bit/s, ${options.canFdEnabled ? 'CAN FD' : 'Classic CAN'}, ${filterText}`,
    hex
  ));

  return { logs, frame: { id, idText, frameFormat, remote, dlc, data, hex } };
}

function parseCanTrace(options = {}) {
  const logs = [];
  const lines = String(options.canTraceInput || options.trace || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  if (!lines.length) {
    logs.push(createLog('error', 'CAN', 'EMPTY_PAYLOAD'));
    return { logs };
  }

  for (const line of lines) {
    const frame = parseCanLine(line, options);
    if (!frame) {
      logs.push(createLog('error', 'CAN', 'INVALID_CAN_TRACE', line));
      continue;
    }

    const idText = formatCanId(frame.id, frame.format);
    const direction = canPassesFilter(frame.id, options) ? 'rx' : 'sys';
    const summary = direction === 'rx'
      ? `CAN RX ${idText} DLC=${frame.dlc}`
      : `CAN ${idText} filtered`;
    const detail = frame.remote
      ? `remote frame, raw=${frame.raw}`
      : `data=${formatHex(frame.data)}, raw=${frame.raw}`;

    logs.push(createLog(
      direction,
      'CAN',
      summary,
      detail,
      frame.remote ? `${idText}#R${frame.dlc}` : `${idText}#${formatCompactHex(frame.data)}`
    ));
  }

  return { logs };
}

function sendRs485Frame(options = {}) {
  const logs = [];
  const mode = options.rs485PayloadMode || options.mode || 'hex';
  const bytes = getRs485PayloadBytes(options.rs485Payload || options.payload || '', mode, logs);
  if (bytes === null) return { logs };

  const frame = options.rs485AppendCrc === false || options.appendCrc === false ? bytes : appendModbusCrc(bytes);
  logs.push(createLog(
    'tx',
    'RS485',
    `RS485 TX ${frame.length}B`,
    `${options.rs485Port || options.port || '-'} ${options.rs485BaudRate || options.baudRate || '9600'}, ${options.rs485DataBits || '8'}${String(options.rs485Parity || 'none')[0]}${options.rs485StopBits || '1'}, ascii="${toAsciiPreview(frame)}"`,
    formatHex(frame)
  ));

  return { logs, frame: { bytes: frame, hex: formatHex(frame) } };
}

function recordRs485Rx(options = {}) {
  const logs = [];
  const mode = options.rs485PayloadMode || options.mode || 'hex';
  const bytes = getRs485PayloadBytes(options.rs485ReceiveInput || options.payload || '', mode, logs);
  if (bytes === null) return { logs };

  logs.push(createLog(
    'rx',
    'RS485',
    `RS485 RX ${bytes.length}B`,
    `ascii="${toAsciiPreview(bytes)}"`,
    formatHex(bytes)
  ));

  return { logs, frame: { bytes, hex: formatHex(bytes) } };
}

function buildModbusRequest(options = {}) {
  const logs = [];
  const protocol = options.modbusProtocol || options.protocol || 'rtu';
  const unitId = getIntegerInRange(options.modbusUnitId ?? options.unitId ?? 1, 0, protocol === 'rtu' ? 247 : 255, 'Modbus', logs);
  const transactionId = getIntegerInRange(options.modbusTransactionId ?? options.transactionId ?? 1, 0, 65535, 'Modbus', logs);
  const pdu = buildModbusPdu(options, logs);
  if (unitId === null || transactionId === null || pdu === null) return { logs, requestHex: '' };

  let frame;
  if (protocol === 'rtu') {
    frame = appendModbusCrc([unitId, ...pdu]);
  } else {
    const length = 1 + pdu.length;
    frame = [
      ...u16(transactionId),
      0x00,
      0x00,
      ...u16(length),
      unitId,
      ...pdu
    ];
  }

  const requestHex = formatHex(frame);
  logs.push(createLog(
    'tx',
    'Modbus',
    `Modbus ${protocol.toUpperCase()} TX FC${options.modbusFunction || options.functionCode || '03'}`,
    `unit=${unitId}, address=${options.modbusAddress ?? options.address ?? 0}, quantity=${options.modbusQuantity ?? options.quantity ?? 2}`,
    requestHex
  ));

  return { logs, requestHex, frame };
}

function parseModbusResponse(options = {}) {
  const logs = [];
  const protocol = options.modbusProtocol || options.protocol || 'rtu';
  const bytes = parseHex(options.modbusResponseHex || options.responseHex || '', 'Modbus', logs);
  if (bytes === null) return { logs };

  logs.push(protocol === 'rtu' ? parseModbusRtu(bytes) : parseModbusTcp(bytes));
  return { logs };
}

function createIndustrialBusDebuggerCore() {
  function status() {
    return {
      state: 'ready',
      pid: process.pid
    };
  }

  async function executeAction(message = {}) {
    const action = message.action || message.method;
    const params = message.params || message.data || message;

    switch (action) {
      case 'status':
        return status();
      case 'can.send':
        return sendCanFrame(params);
      case 'can.parseTrace':
        return parseCanTrace(params);
      case 'rs485.send':
        return sendRs485Frame(params);
      case 'rs485.recordRx':
        return recordRs485Rx(params);
      case 'modbus.buildRequest':
        return buildModbusRequest(params);
      case 'modbus.parseResponse':
        return parseModbusResponse(params);
      case 'shutdown':
        return { closing: true };
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }

  async function shutdown() {
    return { closing: true };
  }

  async function cleanup() {
    return { ok: true };
  }

  return {
    status,
    sendCanFrame,
    parseCanTrace,
    sendRs485Frame,
    recordRs485Rx,
    buildModbusRequest,
    parseModbusResponse,
    executeAction,
    shutdown,
    cleanup
  };
}

module.exports = {
  asError,
  createIndustrialBusDebuggerCore,
  crc16Modbus,
  parseHexBytes,
  formatHex
};
