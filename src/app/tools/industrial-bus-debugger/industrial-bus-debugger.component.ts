import { CommonModule } from '@angular/common';
import { Component, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { SubWindowComponent } from '../../components/sub-window/sub-window.component';
import { ToolContainerComponent } from '../../components/tool-container/tool-container.component';
import { UiService } from '../../services/ui.service';

type BusMode = 'can' | 'rs485' | 'modbus';
type BusLogDirection = 'tx' | 'rx' | 'sys' | 'error';
type CanFrameFormat = 'standard' | 'extended';
type CanFrameType = 'data' | 'remote';
type Rs485PayloadMode = 'hex' | 'ascii';
type ModbusProtocol = 'rtu' | 'tcp';

interface BusLogEntry {
  id: number;
  time: string;
  direction: BusLogDirection;
  protocol: string;
  summary: string;
  detail?: string;
  hex?: string;
}

interface ParsedCanFrame {
  id: number;
  format: CanFrameFormat;
  remote: boolean;
  dlc: number;
  data: number[];
  raw: string;
}

interface ModbusFunctionItem {
  code: string;
  label: string;
}

@Component({
  selector: 'app-industrial-bus-debugger',
  imports: [
    CommonModule,
    FormsModule,
    TranslateModule,
    SubWindowComponent,
    ToolContainerComponent
  ],
  templateUrl: './industrial-bus-debugger.component.html',
  styleUrl: './industrial-bus-debugger.component.scss'
})
export class IndustrialBusDebuggerComponent implements OnInit {
  currentUrl = '';
  mode: BusMode = 'can';

  canBitrate = '500000';
  canFrameFormat: CanFrameFormat = 'standard';
  canFrameType: CanFrameType = 'data';
  canFrameId = '123';
  canPayload = '01 02 03 04';
  canDlc = 0;
  canFdEnabled = false;
  canFilterId = '';
  canFilterMask = '7FF';
  canTraceInput = '123#DEADBEEF';

  rs485Port = 'COM3';
  rs485BaudRate = '9600';
  rs485DataBits = '8';
  rs485StopBits = '1';
  rs485Parity = 'none';
  rs485PayloadMode: Rs485PayloadMode = 'hex';
  rs485Payload = '01 03 00 00 00 02';
  rs485AppendCrc = true;
  rs485ReceiveInput = '01 03 04 00 2A 00 64 DA 3F';

  modbusProtocol: ModbusProtocol = 'rtu';
  modbusTransactionId = 1;
  modbusUnitId = 1;
  modbusFunction = '03';
  modbusAddress = 0;
  modbusQuantity = 2;
  modbusWriteValue = '00 01';
  modbusRequestHex = '';
  modbusResponseHex = '01 03 04 00 2A 00 64 DA 3F';

  logs: BusLogEntry[] = [];

  readonly canBitrates = ['125000', '250000', '500000', '1000000'];
  readonly baudRates = ['9600', '19200', '38400', '57600', '115200', '230400'];
  readonly dataBitOptions = ['7', '8'];
  readonly stopBitOptions = ['1', '1.5', '2'];
  readonly parityOptions = [
    { value: 'none', label: 'INDUSTRIAL_BUS_DEBUGGER.NONE' },
    { value: 'even', label: 'INDUSTRIAL_BUS_DEBUGGER.EVEN' },
    { value: 'odd', label: 'INDUSTRIAL_BUS_DEBUGGER.ODD' }
  ];
  readonly modbusFunctions: ModbusFunctionItem[] = [
    { code: '01', label: 'INDUSTRIAL_BUS_DEBUGGER.READ_COILS' },
    { code: '02', label: 'INDUSTRIAL_BUS_DEBUGGER.READ_DISCRETE_INPUTS' },
    { code: '03', label: 'INDUSTRIAL_BUS_DEBUGGER.READ_HOLDING_REGISTERS' },
    { code: '04', label: 'INDUSTRIAL_BUS_DEBUGGER.READ_INPUT_REGISTERS' },
    { code: '05', label: 'INDUSTRIAL_BUS_DEBUGGER.WRITE_SINGLE_COIL' },
    { code: '06', label: 'INDUSTRIAL_BUS_DEBUGGER.WRITE_SINGLE_REGISTER' },
    { code: '0F', label: 'INDUSTRIAL_BUS_DEBUGGER.WRITE_MULTIPLE_COILS' },
    { code: '10', label: 'INDUSTRIAL_BUS_DEBUGGER.WRITE_MULTIPLE_REGISTERS' }
  ];

  private logSeq = 0;
  private readonly textEncoder = new TextEncoder();

  constructor(
    private router: Router,
    private uiService: UiService
  ) { }

  ngOnInit(): void {
    this.currentUrl = this.router.url;
  }

  close(): void {
    this.uiService.closeTool('industrial-bus-debugger');
  }

  sendCanFrame(): void {
    const id = this.parseHexNumber(this.canFrameId);
    if (id === null || !this.isValidCanId(id, this.canFrameFormat)) {
      this.pushLog('error', 'CAN', 'INDUSTRIAL_BUS_DEBUGGER.INVALID_CAN_ID', this.canFrameId);
      return;
    }

    const maxBytes = this.canFdEnabled ? 64 : 8;
    const remote = this.canFrameType === 'remote';
    let data: number[] = [];
    let dlc = 0;

    if (remote) {
      dlc = this.clampInteger(this.canDlc, 0, maxBytes);
    } else {
      const parsed = this.parseHex(this.canPayload, 'CAN', true);
      if (parsed === null) {
        return;
      }
      data = parsed;
      dlc = data.length;
      if (data.length > maxBytes) {
        this.pushLog('error', 'CAN', 'INDUSTRIAL_BUS_DEBUGGER.CAN_PAYLOAD_TOO_LONG', `${data.length}/${maxBytes}`);
        return;
      }
    }

    const idText = this.formatCanId(id, this.canFrameFormat);
    const hex = remote ? `${idText}#R${dlc}` : `${idText}#${this.formatCompactHex(data)}`;
    const filterText = this.canPassesFilter(id)
      ? 'filter=pass'
      : 'filter=skip';

    this.pushLog(
      'tx',
      'CAN',
      `CAN TX ${idText} DLC=${dlc}`,
      `${this.canBitrate} bit/s, ${this.canFdEnabled ? 'CAN FD' : 'Classic CAN'}, ${filterText}`,
      hex
    );
  }

  parseCanTrace(): void {
    const lines = this.canTraceInput.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (lines.length === 0) {
      this.pushLog('error', 'CAN', 'INDUSTRIAL_BUS_DEBUGGER.EMPTY_PAYLOAD');
      return;
    }

    for (const line of lines) {
      const frame = this.parseCanLine(line);
      if (!frame) {
        this.pushLog('error', 'CAN', 'INDUSTRIAL_BUS_DEBUGGER.INVALID_CAN_TRACE', line);
        continue;
      }

      const idText = this.formatCanId(frame.id, frame.format);
      const direction: BusLogDirection = this.canPassesFilter(frame.id) ? 'rx' : 'sys';
      const summary = direction === 'rx'
        ? `CAN RX ${idText} DLC=${frame.dlc}`
        : `CAN ${idText} filtered`;
      const detail = frame.remote
        ? `remote frame, raw=${frame.raw}`
        : `data=${this.formatHex(frame.data)}, raw=${frame.raw}`;

      this.pushLog(direction, 'CAN', summary, detail, frame.remote ? `${idText}#R${frame.dlc}` : `${idText}#${this.formatCompactHex(frame.data)}`);
    }
  }

  sendRs485Frame(): void {
    const bytes = this.getRs485PayloadBytes(this.rs485Payload);
    if (bytes === null) {
      return;
    }

    const frame = this.rs485AppendCrc ? this.appendModbusCrc(bytes) : bytes;
    this.pushLog(
      'tx',
      'RS485',
      `RS485 TX ${frame.length}B`,
      `${this.rs485Port || '-'} ${this.rs485BaudRate}, ${this.rs485DataBits}${this.rs485Parity[0]}${this.rs485StopBits}, ascii="${this.toAsciiPreview(frame)}"`,
      this.formatHex(frame)
    );
  }

  recordRs485Rx(): void {
    const bytes = this.getRs485PayloadBytes(this.rs485ReceiveInput);
    if (bytes === null) {
      return;
    }

    this.pushLog(
      'rx',
      'RS485',
      `RS485 RX ${bytes.length}B`,
      `ascii="${this.toAsciiPreview(bytes)}"`,
      this.formatHex(bytes)
    );
  }

  buildModbusRequest(): void {
    const unitId = this.getIntegerInRange(this.modbusUnitId, 0, this.modbusProtocol === 'rtu' ? 247 : 255, 'Modbus');
    const transactionId = this.getIntegerInRange(this.modbusTransactionId, 0, 65535, 'Modbus');
    const pdu = this.buildModbusPdu();
    if (unitId === null || transactionId === null || pdu === null) {
      return;
    }

    let frame: number[];
    if (this.modbusProtocol === 'rtu') {
      frame = this.appendModbusCrc([unitId, ...pdu]);
    } else {
      const length = 1 + pdu.length;
      frame = [
        ...this.u16(transactionId),
        0x00,
        0x00,
        ...this.u16(length),
        unitId,
        ...pdu
      ];
    }

    this.modbusRequestHex = this.formatHex(frame);
    this.pushLog(
      'tx',
      'Modbus',
      `Modbus ${this.modbusProtocol.toUpperCase()} TX FC${this.modbusFunction}`,
      `unit=${unitId}, address=${this.modbusAddress}, quantity=${this.modbusQuantity}`,
      this.modbusRequestHex
    );
  }

  parseModbusResponse(): void {
    const bytes = this.parseHex(this.modbusResponseHex, 'Modbus');
    if (bytes === null) {
      return;
    }

    if (this.modbusProtocol === 'rtu') {
      this.parseModbusRtu(bytes);
    } else {
      this.parseModbusTcp(bytes);
    }
  }

  copyModbusRequest(): void {
    if (!this.modbusRequestHex) {
      this.pushLog('error', 'Modbus', 'INDUSTRIAL_BUS_DEBUGGER.NO_REQUEST');
      return;
    }

    navigator.clipboard?.writeText(this.modbusRequestHex);
    this.pushLog('sys', 'Modbus', 'INDUSTRIAL_BUS_DEBUGGER.COPIED', '', this.modbusRequestHex);
  }

  clearLogs(): void {
    this.logs = [];
  }

  private buildModbusPdu(): number[] | null {
    const functionCode = Number.parseInt(this.modbusFunction, 16);
    const address = this.getIntegerInRange(this.modbusAddress, 0, 65535, 'Modbus');
    const quantity = this.getIntegerInRange(this.modbusQuantity, 1, 2000, 'Modbus');
    if (address === null || quantity === null || Number.isNaN(functionCode)) {
      return null;
    }

    if ([0x01, 0x02, 0x03, 0x04].includes(functionCode)) {
      return [functionCode, ...this.u16(address), ...this.u16(quantity)];
    }

    if (functionCode === 0x05 || functionCode === 0x06) {
      const value = this.getModbusWriteBytes(functionCode, quantity);
      if (!value) {
        return null;
      }
      return [functionCode, ...this.u16(address), ...value];
    }

    if (functionCode === 0x0f || functionCode === 0x10) {
      const value = this.getModbusWriteBytes(functionCode, quantity);
      if (!value) {
        return null;
      }
      return [functionCode, ...this.u16(address), ...this.u16(quantity), value.length, ...value];
    }

    this.pushLog('error', 'Modbus', 'INDUSTRIAL_BUS_DEBUGGER.INVALID_MODBUS_FIELD', `FC${this.modbusFunction}`);
    return null;
  }

  private getModbusWriteBytes(functionCode: number, quantity: number): number[] | null {
    const parsed = this.parseHex(this.modbusWriteValue, 'Modbus', true);
    if (parsed === null) {
      return null;
    }

    if (functionCode === 0x05 || functionCode === 0x06) {
      const defaultValue = functionCode === 0x05 ? [0xff, 0x00] : [0x00, 0x01];
      const value = parsed.length === 0 ? defaultValue : parsed;
      if (value.length !== 2) {
        this.pushLog('error', 'Modbus', 'INDUSTRIAL_BUS_DEBUGGER.MODBUS_WRITE_LENGTH', '2 bytes required');
        return null;
      }
      return value;
    }

    const requiredLength = functionCode === 0x0f ? Math.ceil(quantity / 8) : quantity * 2;
    const value = parsed.length === 0 ? new Array(requiredLength).fill(0) : parsed;
    if (value.length !== requiredLength) {
      this.pushLog('error', 'Modbus', 'INDUSTRIAL_BUS_DEBUGGER.MODBUS_WRITE_LENGTH', `${requiredLength} bytes required`);
      return null;
    }
    return value;
  }

  private parseModbusRtu(bytes: number[]): void {
    if (bytes.length < 5) {
      this.pushLog('error', 'Modbus', 'INDUSTRIAL_BUS_DEBUGGER.INVALID_MODBUS_FIELD', 'RTU frame too short');
      return;
    }

    const frame = bytes.slice(0, -2);
    const actualCrc = bytes[bytes.length - 2] | (bytes[bytes.length - 1] << 8);
    const expectedCrc = this.crc16Modbus(frame);
    const crcDetail = actualCrc === expectedCrc
      ? 'crc=ok'
      : `crc=bad expected ${this.formatHex([expectedCrc & 0xff, (expectedCrc >> 8) & 0xff])}`;

    this.describeModbusPdu(frame[0], frame.slice(1), crcDetail, bytes);
  }

  private parseModbusTcp(bytes: number[]): void {
    if (bytes.length < 8) {
      this.pushLog('error', 'Modbus', 'INDUSTRIAL_BUS_DEBUGGER.INVALID_MODBUS_FIELD', 'TCP frame too short');
      return;
    }

    const transactionId = (bytes[0] << 8) | bytes[1];
    const protocolId = (bytes[2] << 8) | bytes[3];
    const length = (bytes[4] << 8) | bytes[5];
    const unitId = bytes[6];
    const pdu = bytes.slice(7);
    const lengthDetail = length === bytes.length - 6 ? 'length=ok' : `length=bad header=${length} actual=${bytes.length - 6}`;
    const protocolDetail = protocolId === 0 ? 'protocol=0' : `protocol=${protocolId}`;

    this.describeModbusPdu(unitId, pdu, `tid=${transactionId}, ${protocolDetail}, ${lengthDetail}`, bytes);
  }

  private describeModbusPdu(unitId: number, pdu: number[], detailPrefix: string, rawBytes: number[]): void {
    if (pdu.length < 1) {
      this.pushLog('error', 'Modbus', 'INDUSTRIAL_BUS_DEBUGGER.INVALID_MODBUS_FIELD', 'empty PDU');
      return;
    }

    const functionCode = pdu[0];
    if ((functionCode & 0x80) !== 0) {
      const exceptionCode = pdu[1] ?? 0;
      this.pushLog(
        'error',
        'Modbus',
        'INDUSTRIAL_BUS_DEBUGGER.MODBUS_EXCEPTION',
        `unit=${unitId}, fc=0x${(functionCode & 0x7f).toString(16).padStart(2, '0').toUpperCase()}, exception=0x${exceptionCode.toString(16).padStart(2, '0').toUpperCase()}, ${detailPrefix}`,
        this.formatHex(rawBytes)
      );
      return;
    }

    let detail = `unit=${unitId}, ${detailPrefix}`;
    if ([0x01, 0x02, 0x03, 0x04].includes(functionCode) && pdu.length >= 2) {
      const byteCount = pdu[1];
      const data = pdu.slice(2, 2 + byteCount);
      detail += `, byteCount=${byteCount}, data=${this.formatHex(data)}`;
      if ((functionCode === 0x03 || functionCode === 0x04) && data.length % 2 === 0) {
        detail += `, registers=${this.formatRegisterValues(data)}`;
      }
    } else if ([0x05, 0x06, 0x0f, 0x10].includes(functionCode) && pdu.length >= 5) {
      const address = (pdu[1] << 8) | pdu[2];
      const value = (pdu[3] << 8) | pdu[4];
      detail += `, address=${address}, value=${value}`;
    }

    this.pushLog(
      'rx',
      'Modbus',
      `Modbus ${this.modbusProtocol.toUpperCase()} RX FC${functionCode.toString(16).padStart(2, '0').toUpperCase()}`,
      detail,
      this.formatHex(rawBytes)
    );
  }

  private parseCanLine(line: string): ParsedCanFrame | null {
    const compactLine = line.replace(/\s+/g, '');
    const compactMatch = compactLine.match(/^([0-9a-fA-F]{1,8})#([Rr]?[0-9a-fA-F]*)$/);
    if (compactMatch) {
      const id = this.parseHexNumber(compactMatch[1]);
      if (id === null || id > 0x1fffffff) {
        return null;
      }
      const payload = compactMatch[2];
      const remote = /^[Rr]/.test(payload);
      const dataText = remote ? payload.slice(1) : payload;
      const data = remote ? [] : this.parseHexBytes(dataText);
      if (data === null) {
        return null;
      }
      const dlc = remote ? this.clampInteger(Number.parseInt(dataText || '0', 10), 0, this.canFdEnabled ? 64 : 8) : data.length;
      return {
        id,
        format: id > 0x7ff ? 'extended' : 'standard',
        remote,
        dlc,
        data,
        raw: line
      };
    }

    const candumpMatch = line.match(/^(?:\S+\s+)?([0-9a-fA-F]{1,8})\s+\[(\d{1,2})\]\s*(.*)$/);
    if (candumpMatch) {
      const id = this.parseHexNumber(candumpMatch[1]);
      const dlc = Number.parseInt(candumpMatch[2], 10);
      const data = this.parseHexBytes(candumpMatch[3]);
      if (id === null || data === null || id > 0x1fffffff) {
        return null;
      }
      return {
        id,
        format: id > 0x7ff ? 'extended' : 'standard',
        remote: false,
        dlc,
        data,
        raw: line
      };
    }

    const tokens = line.split(/[\s,]+/).filter(Boolean);
    if (tokens.length >= 1) {
      const id = this.parseHexNumber(tokens[0]);
      const data = this.parseHexBytes(tokens.slice(1).join(' '));
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

  private getRs485PayloadBytes(value: string): number[] | null {
    if (this.rs485PayloadMode === 'hex') {
      return this.parseHex(value, 'RS485');
    }

    if (!value) {
      this.pushLog('error', 'RS485', 'INDUSTRIAL_BUS_DEBUGGER.EMPTY_PAYLOAD');
      return null;
    }
    return Array.from(this.textEncoder.encode(value));
  }

  private parseHex(value: string, protocol: string, allowEmpty = false): number[] | null {
    const bytes = this.parseHexBytes(value);
    if (bytes === null) {
      this.pushLog('error', protocol, 'INDUSTRIAL_BUS_DEBUGGER.INVALID_HEX', value);
      return null;
    }
    if (bytes.length === 0 && !allowEmpty) {
      this.pushLog('error', protocol, 'INDUSTRIAL_BUS_DEBUGGER.EMPTY_PAYLOAD');
      return null;
    }
    return bytes;
  }

  private parseHexBytes(value: string): number[] | null {
    const compact = value.replace(/0x/gi, '').replace(/[\s,;:_-]/g, '');
    if (!compact) {
      return [];
    }
    if (compact.length % 2 !== 0 || /[^0-9a-f]/i.test(compact)) {
      return null;
    }

    const bytes: number[] = [];
    for (let index = 0; index < compact.length; index += 2) {
      bytes.push(Number.parseInt(compact.slice(index, index + 2), 16));
    }
    return bytes;
  }

  private parseHexNumber(value: string): number | null {
    const compact = String(value).trim().replace(/^0x/i, '');
    if (!compact || /[^0-9a-f]/i.test(compact)) {
      return null;
    }
    return Number.parseInt(compact, 16);
  }

  private getIntegerInRange(value: number | string, min: number, max: number, protocol: string): number | null {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < min || parsed > max) {
      this.pushLog('error', protocol, 'INDUSTRIAL_BUS_DEBUGGER.INVALID_MODBUS_FIELD', `${value} (${min}-${max})`);
      return null;
    }
    return parsed;
  }

  private isValidCanId(id: number, format: CanFrameFormat): boolean {
    return id >= 0 && id <= (format === 'standard' ? 0x7ff : 0x1fffffff);
  }

  private canPassesFilter(id: number): boolean {
    if (!this.canFilterId.trim()) {
      return true;
    }

    const filterId = this.parseHexNumber(this.canFilterId);
    const mask = this.parseHexNumber(this.canFilterMask || (this.canFrameFormat === 'standard' ? '7FF' : '1FFFFFFF'));
    if (filterId === null || mask === null) {
      return true;
    }

    return (id & mask) === (filterId & mask);
  }

  private appendModbusCrc(bytes: number[]): number[] {
    const crc = this.crc16Modbus(bytes);
    return [...bytes, crc & 0xff, (crc >> 8) & 0xff];
  }

  private crc16Modbus(bytes: number[]): number {
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

  private u16(value: number): number[] {
    return [(value >> 8) & 0xff, value & 0xff];
  }

  private clampInteger(value: number, min: number, max: number): number {
    const parsed = Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : min;
    return Math.max(min, Math.min(max, parsed));
  }

  private formatCanId(id: number, format: CanFrameFormat): string {
    return id.toString(16).toUpperCase().padStart(format === 'standard' ? 3 : 8, '0');
  }

  private formatHex(bytes: number[]): string {
    return bytes.map(byte => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ');
  }

  private formatCompactHex(bytes: number[]): string {
    return bytes.map(byte => byte.toString(16).padStart(2, '0').toUpperCase()).join('');
  }

  private formatRegisterValues(bytes: number[]): string {
    const values: string[] = [];
    for (let index = 0; index < bytes.length; index += 2) {
      const value = (bytes[index] << 8) | bytes[index + 1];
      values.push(`0x${value.toString(16).padStart(4, '0').toUpperCase()}`);
    }
    return values.join(', ');
  }

  private toAsciiPreview(bytes: number[]): string {
    return bytes.map(byte => byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.').join('');
  }

  private pushLog(direction: BusLogDirection, protocol: string, summary: string, detail = '', hex = ''): void {
    this.logs.unshift({
      id: this.logSeq++,
      time: this.now(),
      direction,
      protocol,
      summary,
      detail,
      hex
    });
    this.logs = this.logs.slice(0, 160);
  }

  private now(): string {
    return new Date().toLocaleTimeString();
  }
}
