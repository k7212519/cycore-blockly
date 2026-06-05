import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { SubWindowComponent } from '../../components/sub-window/sub-window.component';
import { ToolContainerComponent } from '../../components/tool-container/tool-container.component';
import { UiService } from '../../services/ui.service';

type NetworkMode = 'http' | 'websocket';
type NetworkLogType = 'request' | 'response' | 'system' | 'error';

interface NetworkLogEntry {
  time: string;
  type: NetworkLogType;
  label: string;
  detail?: string;
}

interface ResponseHeaderItem {
  name: string;
  value: string;
}

@Component({
  selector: 'app-network-debugger',
  imports: [
    CommonModule,
    FormsModule,
    TranslateModule,
    SubWindowComponent,
    ToolContainerComponent
  ],
  templateUrl: './network-debugger.component.html',
  styleUrl: './network-debugger.component.scss'
})
export class NetworkDebuggerComponent implements OnInit, OnDestroy {
  currentUrl = '';
  mode: NetworkMode = 'http';

  httpMethod = 'GET';
  httpUrl = '';
  httpHeadersText = '';
  httpBody = '';
  httpTimeout = 10000;
  httpLoading = false;
  responseStatus = '';
  responseDuration = 0;
  responseSize = 0;
  responseBody = '';
  responseHeaders: ResponseHeaderItem[] = [];
  httpLogs: NetworkLogEntry[] = [];

  wsUrl = '';
  wsMessage = '';
  wsConnected = false;
  wsLogs: NetworkLogEntry[] = [];
  private socket: WebSocket | null = null;

  readonly httpMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

  constructor(
    private router: Router,
    private uiService: UiService
  ) { }

  ngOnInit(): void {
    this.currentUrl = this.router.url;
  }

  ngOnDestroy(): void {
    this.closeSocket();
  }

  close(): void {
    this.uiService.closeTool('network-debugger');
  }

  async sendHttpRequest(): Promise<void> {
    const url = this.httpUrl.trim();
    if (!/^https?:\/\//i.test(url)) {
      this.pushHttpLog('error', 'NETWORK_DEBUGGER.INVALID_HTTP_URL');
      return;
    }

    const headers = this.parseHeaders(this.httpHeadersText);
    if (!headers) {
      return;
    }

    const controller = new AbortController();
    const timeout = Math.max(1000, Number(this.httpTimeout) || 10000);
    const timer = setTimeout(() => controller.abort(), timeout);
    const startedAt = performance.now();

    this.httpLoading = true;
    this.responseStatus = '';
    this.responseDuration = 0;
    this.responseSize = 0;
    this.responseBody = '';
    this.responseHeaders = [];
    this.pushHttpLog('request', `${this.httpMethod} ${url}`);

    try {
      const init: RequestInit = {
        method: this.httpMethod,
        headers,
        signal: controller.signal
      };

      if (!['GET', 'HEAD'].includes(this.httpMethod) && this.httpBody.length > 0) {
        init.body = this.httpBody;
      }

      const response = await fetch(url, init);
      const text = await response.text();
      this.responseDuration = Math.round(performance.now() - startedAt);
      this.responseStatus = `${response.status} ${response.statusText}`.trim();
      this.responseBody = text;
      this.responseSize = new TextEncoder().encode(text).length;
      this.responseHeaders = [];
      response.headers.forEach((value, name) => {
        this.responseHeaders.push({ name, value });
      });
      this.pushHttpLog('response', this.responseStatus, `${this.responseDuration} ms`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.pushHttpLog('error', message || 'NETWORK_DEBUGGER.REQUEST_FAILED');
    } finally {
      clearTimeout(timer);
      this.httpLoading = false;
    }
  }

  clearHttp(): void {
    this.responseStatus = '';
    this.responseDuration = 0;
    this.responseSize = 0;
    this.responseBody = '';
    this.responseHeaders = [];
    this.httpLogs = [];
  }

  connectWebSocket(): void {
    const url = this.wsUrl.trim();
    if (!/^wss?:\/\//i.test(url)) {
      this.pushWsLog('error', 'NETWORK_DEBUGGER.INVALID_WS_URL');
      return;
    }

    this.closeSocket();
    this.pushWsLog('system', 'NETWORK_DEBUGGER.CONNECTING');

    try {
      const socket = new WebSocket(url);
      this.socket = socket;

      socket.onopen = () => {
        this.wsConnected = true;
        this.pushWsLog('system', 'NETWORK_DEBUGGER.CONNECTED');
      };

      socket.onmessage = (event) => {
        this.pushWsLog('response', 'NETWORK_DEBUGGER.RECEIVED', this.formatSocketData(event.data));
      };

      socket.onerror = () => {
        this.pushWsLog('error', 'NETWORK_DEBUGGER.WS_ERROR');
      };

      socket.onclose = (event) => {
        this.wsConnected = false;
        this.pushWsLog('system', 'NETWORK_DEBUGGER.DISCONNECTED', `${event.code} ${event.reason}`.trim());
        if (this.socket === socket) {
          this.socket = null;
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.pushWsLog('error', message || 'NETWORK_DEBUGGER.WS_ERROR');
    }
  }

  disconnectWebSocket(): void {
    this.closeSocket();
  }

  sendWebSocketMessage(): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.pushWsLog('error', 'NETWORK_DEBUGGER.WS_NOT_CONNECTED');
      return;
    }

    this.socket.send(this.wsMessage);
    this.pushWsLog('request', 'NETWORK_DEBUGGER.SENT', this.wsMessage);
  }

  clearWsLogs(): void {
    this.wsLogs = [];
  }

  private parseHeaders(text: string): Headers | null {
    const headers = new Headers();
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);

    for (const line of lines) {
      const separatorIndex = line.indexOf(':');
      if (separatorIndex <= 0) {
        this.pushHttpLog('error', 'NETWORK_DEBUGGER.INVALID_HEADER', line);
        return null;
      }

      const name = line.slice(0, separatorIndex).trim();
      const value = line.slice(separatorIndex + 1).trim();
      headers.set(name, value);
    }

    return headers;
  }

  private closeSocket(): void {
    if (!this.socket) {
      this.wsConnected = false;
      return;
    }

    const socket = this.socket;
    this.socket = null;

    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }

    this.wsConnected = false;
  }

  private formatSocketData(data: unknown): string {
    if (typeof data === 'string') {
      return data;
    }

    if (data instanceof ArrayBuffer) {
      return `ArrayBuffer(${data.byteLength})`;
    }

    if (data instanceof Blob) {
      return `Blob(${data.size})`;
    }

    return String(data);
  }

  private pushHttpLog(type: NetworkLogType, label: string, detail = ''): void {
    this.httpLogs.unshift({
      type,
      label,
      detail,
      time: this.now()
    });
    this.httpLogs = this.httpLogs.slice(0, 80);
  }

  private pushWsLog(type: NetworkLogType, label: string, detail = ''): void {
    this.wsLogs.unshift({
      type,
      label,
      detail,
      time: this.now()
    });
    this.wsLogs = this.wsLogs.slice(0, 120);
  }

  private now(): string {
    return new Date().toLocaleTimeString();
  }
}
