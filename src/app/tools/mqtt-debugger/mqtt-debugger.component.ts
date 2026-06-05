import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { SubWindowComponent } from '../../components/sub-window/sub-window.component';
import { ToolContainerComponent } from '../../components/tool-container/tool-container.component';
import { UiService } from '../../services/ui.service';
import { ToolI18nService } from '../../services/tool-i18n.service';

type MqttConnectionState = 'disconnected' | 'connecting' | 'connected';
type MqttLogType = 'system' | 'out' | 'in' | 'error';

interface MqttLogEntry {
  time: string;
  type: MqttLogType;
  label: string;
  detail?: string;
}

interface MqttMessageEntry {
  time: string;
  topic: string;
  payload: string;
  qos: number;
  retain: boolean;
}

@Component({
  selector: 'app-mqtt-debugger',
  imports: [
    CommonModule,
    FormsModule,
    TranslateModule,
    SubWindowComponent,
    ToolContainerComponent
  ],
  templateUrl: './mqtt-debugger.component.html',
  styleUrl: './mqtt-debugger.component.scss'
})
export class MqttDebuggerComponent implements OnInit, OnDestroy {
  currentUrl = '';

  brokerUrl = 'wss://test.mosquitto.org:8081/mqtt';
  clientId = `aily-${Math.random().toString(16).slice(2, 10)}`;
  username = '';
  password = '';
  keepAlive = 60;
  cleanSession = true;
  connectionState: MqttConnectionState = 'disconnected';

  subscribeTopic = '#';
  subscribeQos = 0;
  subscriptions: string[] = [];

  publishTopic = 'aily/test';
  publishPayload = '';
  publishRetain = false;

  messages: MqttMessageEntry[] = [];
  logs: MqttLogEntry[] = [];
  readonly qosOptions = [0, 1];

  private socket: WebSocket | null = null;
  private packetId = 1;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private readonly textEncoder = new TextEncoder();
  private readonly textDecoder = new TextDecoder();

  constructor(
    private router: Router,
    private uiService: UiService,
    private toolI18n: ToolI18nService
  ) { }

  ngOnInit(): void {
    void this.initTool();
  }

  private async initTool(): Promise<void> {
    await this.toolI18n.load('mqtt-debugger');
    this.currentUrl = this.router.url;
  }

  ngOnDestroy(): void {
    this.closeSocket(false);
  }

  get isConnected(): boolean {
    return this.connectionState === 'connected';
  }

  get statusKey(): string {
    return `MQTT_DEBUGGER.STATUS_${this.connectionState.toUpperCase()}`;
  }

  close(): void {
    this.uiService.closeTool('mqtt-debugger');
  }

  connect(): void {
    const url = this.brokerUrl.trim();
    if (!/^wss?:\/\//i.test(url)) {
      this.pushLog('error', 'MQTT_DEBUGGER.INVALID_WS_URL');
      return;
    }

    const clientId = this.clientId.trim();
    if (!clientId) {
      this.pushLog('error', 'MQTT_DEBUGGER.CLIENT_ID_REQUIRED');
      return;
    }

    this.closeSocket(false);
    this.connectionState = 'connecting';
    this.pushLog('system', 'MQTT_DEBUGGER.CONNECTING', url);

    try {
      const socket = new WebSocket(url, ['mqtt']);
      socket.binaryType = 'arraybuffer';
      this.socket = socket;

      socket.onopen = () => {
        this.sendConnectPacket();
      };

      socket.onmessage = async (event) => {
        if (event.data instanceof ArrayBuffer) {
          this.handlePacket(new Uint8Array(event.data));
        } else if (event.data instanceof Blob) {
          const buffer = await event.data.arrayBuffer();
          this.handlePacket(new Uint8Array(buffer));
        } else {
          this.pushLog('error', 'MQTT_DEBUGGER.UNSUPPORTED_PACKET', String(event.data));
        }
      };

      socket.onerror = () => {
        this.pushLog('error', 'MQTT_DEBUGGER.SOCKET_ERROR');
      };

      socket.onclose = (event) => {
        this.stopPing();
        this.connectionState = 'disconnected';
        this.pushLog('system', 'MQTT_DEBUGGER.DISCONNECTED', `${event.code} ${event.reason}`.trim());
        if (this.socket === socket) {
          this.socket = null;
        }
      };
    } catch (error) {
      this.connectionState = 'disconnected';
      const message = error instanceof Error ? error.message : String(error);
      this.pushLog('error', message || 'MQTT_DEBUGGER.SOCKET_ERROR');
    }
  }

  disconnect(): void {
    if (this.isSocketOpen()) {
      this.sendPacket(new Uint8Array([0xe0, 0x00]));
      this.pushLog('out', 'MQTT_DEBUGGER.DISCONNECT_SENT');
    }
    this.closeSocket();
  }

  subscribe(): void {
    const topic = this.subscribeTopic.trim();
    if (!this.isConnected || !topic) {
      return;
    }

    const packetId = this.nextPacketId();
    const body = this.concat(
      this.bytes([(packetId >> 8) & 0xff, packetId & 0xff]),
      this.encodeString(topic),
      this.bytes([Number(this.subscribeQos) & 0x01])
    );

    this.sendControlPacket(0x82, body);
    if (!this.subscriptions.includes(topic)) {
      this.subscriptions = [topic, ...this.subscriptions].slice(0, 20);
    }
    this.pushLog('out', 'MQTT_DEBUGGER.SUBSCRIBE_SENT', topic);
  }

  unsubscribe(topic = this.subscribeTopic): void {
    const nextTopic = topic.trim();
    if (!this.isConnected || !nextTopic) {
      return;
    }

    const packetId = this.nextPacketId();
    const body = this.concat(
      this.bytes([(packetId >> 8) & 0xff, packetId & 0xff]),
      this.encodeString(nextTopic)
    );

    this.sendControlPacket(0xa2, body);
    this.subscriptions = this.subscriptions.filter(item => item !== nextTopic);
    this.pushLog('out', 'MQTT_DEBUGGER.UNSUBSCRIBE_SENT', nextTopic);
  }

  publish(): void {
    const topic = this.publishTopic.trim();
    if (!this.isConnected || !topic) {
      return;
    }

    const topicBytes = this.encodeString(topic);
    const payloadBytes = this.textEncoder.encode(this.publishPayload);
    const header = 0x30 | (this.publishRetain ? 0x01 : 0);
    this.sendControlPacket(header, this.concat(topicBytes, payloadBytes));
    this.pushLog('out', 'MQTT_DEBUGGER.PUBLISH_SENT', topic);
  }

  clearMessages(): void {
    this.messages = [];
  }

  clearLogs(): void {
    this.logs = [];
  }

  private sendConnectPacket(): void {
    const flags =
      (this.username.trim() ? 0x80 : 0) |
      (this.password ? 0x40 : 0) |
      (this.cleanSession ? 0x02 : 0);

    const keepAlive = Math.max(0, Math.min(65535, Number(this.keepAlive) || 0));
    const variableHeader = this.concat(
      this.encodeString('MQTT'),
      this.bytes([0x04, flags, (keepAlive >> 8) & 0xff, keepAlive & 0xff])
    );

    const payloadParts = [this.encodeString(this.clientId.trim())];
    if (this.username.trim()) {
      payloadParts.push(this.encodeString(this.username.trim()));
    }
    if (this.password) {
      payloadParts.push(this.encodeString(this.password));
    }

    this.sendControlPacket(0x10, this.concat(variableHeader, ...payloadParts));
    this.pushLog('out', 'MQTT_DEBUGGER.CONNECT_SENT', this.clientId.trim());
  }

  private handlePacket(bytes: Uint8Array): void {
    if (bytes.length < 2) {
      this.pushLog('error', 'MQTT_DEBUGGER.INVALID_PACKET');
      return;
    }

    const packetType = bytes[0] >> 4;
    const remaining = this.decodeRemainingLength(bytes);
    const bodyStart = remaining.offset;
    const bodyEnd = Math.min(bytes.length, bodyStart + remaining.length);

    switch (packetType) {
      case 2:
        this.handleConnack(bytes, bodyStart);
        break;
      case 3:
        this.handlePublish(bytes, bodyStart, bodyEnd);
        break;
      case 9:
        this.pushLog('in', 'MQTT_DEBUGGER.SUBACK_RECEIVED');
        break;
      case 11:
        this.pushLog('in', 'MQTT_DEBUGGER.UNSUBACK_RECEIVED');
        break;
      case 13:
        this.pushLog('in', 'MQTT_DEBUGGER.PINGRESP_RECEIVED');
        break;
      default:
        this.pushLog('in', 'MQTT_DEBUGGER.PACKET_RECEIVED', `type=${packetType}`);
        break;
    }
  }

  private handleConnack(bytes: Uint8Array, offset: number): void {
    const returnCode = bytes[offset + 1];
    if (returnCode === 0) {
      this.connectionState = 'connected';
      this.pushLog('in', 'MQTT_DEBUGGER.CONNECTED');
      this.startPing();
      return;
    }

    this.connectionState = 'disconnected';
    this.pushLog('error', 'MQTT_DEBUGGER.CONNACK_FAILED', String(returnCode));
    this.closeSocket(false);
  }

  private handlePublish(bytes: Uint8Array, offset: number, end: number): void {
    const flags = bytes[0] & 0x0f;
    const qos = (flags & 0x06) >> 1;
    const retain = (flags & 0x01) === 0x01;
    const topicResult = this.readString(bytes, offset);
    let cursor = topicResult.offset;
    let packetId = 0;

    if (qos > 0) {
      packetId = (bytes[cursor] << 8) | bytes[cursor + 1];
      cursor += 2;
    }

    const payload = this.textDecoder.decode(bytes.slice(cursor, end));
    this.messages.unshift({
      time: this.now(),
      topic: topicResult.value,
      payload,
      qos,
      retain
    });
    this.messages = this.messages.slice(0, 100);
    this.pushLog('in', 'MQTT_DEBUGGER.MESSAGE_RECEIVED', topicResult.value);

    if (qos === 1 && packetId > 0) {
      this.sendPacket(this.bytes([0x40, 0x02, (packetId >> 8) & 0xff, packetId & 0xff]));
    }
  }

  private sendControlPacket(header: number, body: Uint8Array): void {
    const packet = this.concat(
      this.bytes([header]),
      this.encodeRemainingLength(body.length),
      body
    );
    this.sendPacket(packet);
  }

  private sendPacket(packet: Uint8Array): void {
    if (!this.isSocketOpen()) {
      this.pushLog('error', 'MQTT_DEBUGGER.SOCKET_NOT_CONNECTED');
      return;
    }

    this.socket?.send(packet);
  }

  private startPing(): void {
    this.stopPing();
    const keepAlive = Math.max(0, Number(this.keepAlive) || 0);
    if (!keepAlive) {
      return;
    }

    const intervalMs = Math.max(10000, Math.floor(keepAlive * 1000 / 2));
    this.pingTimer = setInterval(() => {
      if (this.isConnected) {
        this.sendPacket(this.bytes([0xc0, 0x00]));
        this.pushLog('out', 'MQTT_DEBUGGER.PINGREQ_SENT');
      }
    }, intervalMs);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private closeSocket(pushLog = true): void {
    this.stopPing();

    const socket = this.socket;
    this.socket = null;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      socket.close();
    }

    this.connectionState = 'disconnected';
    if (pushLog) {
      this.pushLog('system', 'MQTT_DEBUGGER.DISCONNECTED');
    }
  }

  private isSocketOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  private nextPacketId(): number {
    const next = this.packetId;
    this.packetId += 1;
    if (this.packetId > 65535) {
      this.packetId = 1;
    }
    return next;
  }

  private encodeString(value: string): Uint8Array {
    const encoded = this.textEncoder.encode(value);
    return this.concat(this.bytes([(encoded.length >> 8) & 0xff, encoded.length & 0xff]), encoded);
  }

  private readString(bytes: Uint8Array, offset: number): { value: string; offset: number } {
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    const start = offset + 2;
    const end = start + length;
    return {
      value: this.textDecoder.decode(bytes.slice(start, end)),
      offset: end
    };
  }

  private encodeRemainingLength(length: number): Uint8Array {
    const encoded: number[] = [];
    let value = length;

    do {
      let byte = value % 128;
      value = Math.floor(value / 128);
      if (value > 0) {
        byte |= 128;
      }
      encoded.push(byte);
    } while (value > 0);

    return this.bytes(encoded);
  }

  private decodeRemainingLength(bytes: Uint8Array): { length: number; offset: number } {
    let multiplier = 1;
    let value = 0;
    let offset = 1;
    let encodedByte = 0;

    do {
      encodedByte = bytes[offset] || 0;
      value += (encodedByte & 127) * multiplier;
      multiplier *= 128;
      offset += 1;
    } while ((encodedByte & 128) !== 0 && offset < bytes.length);

    return { length: value, offset };
  }

  private concat(...parts: Uint8Array[]): Uint8Array {
    const length = parts.reduce((sum, part) => sum + part.length, 0);
    const result = new Uint8Array(length);
    let offset = 0;

    for (const part of parts) {
      result.set(part, offset);
      offset += part.length;
    }

    return result;
  }

  private bytes(values: number[]): Uint8Array {
    return new Uint8Array(values);
  }

  private pushLog(type: MqttLogType, label: string, detail = ''): void {
    this.logs.unshift({
      type,
      label,
      detail,
      time: this.now()
    });
    this.logs = this.logs.slice(0, 120);
  }

  private now(): string {
    return new Date().toLocaleTimeString();
  }
}
