import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit } from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { Router } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { SubWindowComponent } from '../../components/sub-window/sub-window.component';
import { ToolContainerComponent } from '../../components/tool-container/tool-container.component';
import { ToolI18nService } from '../../services/tool-i18n.service';
import { UiService } from '../../services/ui.service';
import { BleDebuggerBackendService, BleDebuggerHostInfo } from './ble-debugger-backend.service';

type HostStatus = 'idle' | 'starting' | 'ready' | 'error' | 'closed';

@Component({
  selector: 'app-ble-debugger',
  imports: [
    CommonModule,
    TranslateModule,
    SubWindowComponent,
    ToolContainerComponent
  ],
  templateUrl: './ble-debugger.component.html',
  styleUrl: './ble-debugger.component.scss'
})
export class BleDebuggerComponent implements OnInit, OnDestroy {
  currentUrl = '';
  hostStatus: HostStatus = 'idle';
  iframeSrc: SafeResourceUrl | null = null;
  frameLoaded = false;
  errorMessage = '';
  serverInfo: BleDebuggerHostInfo | null = null;

  constructor(
    private router: Router,
    private uiService: UiService,
    private toolI18n: ToolI18nService,
    private sanitizer: DomSanitizer,
    private backend: BleDebuggerBackendService
  ) { }

  ngOnInit(): void {
    void this.initTool();
  }

  ngOnDestroy(): void {
    void this.backend.stop();
  }

  close(): void {
    this.uiService.closeTool('ble-debugger');
  }

  async restart(): Promise<void> {
    await this.backend.stop();
    this.serverInfo = null;
    this.iframeSrc = null;
    this.frameLoaded = false;
    this.hostStatus = 'closed';
    await this.startServer();
  }

  onFrameLoad(): void {
    this.frameLoaded = true;
  }

  get hostStatusKey(): string {
    if (this.hostStatus === 'ready') return 'BLE_DEBUGGER.BACKEND_READY';
    if (this.hostStatus === 'starting') return 'BLE_DEBUGGER.BACKEND_STARTING';
    if (this.hostStatus === 'error') return 'BLE_DEBUGGER.BACKEND_ERROR';
    return 'BLE_DEBUGGER.BACKEND_CLOSED';
  }

  private async initTool(): Promise<void> {
    await this.toolI18n.load('ble-debugger');
    this.currentUrl = this.router.url;
    await this.startServer();
  }

  private async startServer(): Promise<void> {
    if (this.hostStatus === 'starting' || this.hostStatus === 'ready') {
      return;
    }

    this.hostStatus = 'starting';
    this.errorMessage = '';
    this.frameLoaded = false;

    try {
      this.serverInfo = await this.backend.start();
      this.iframeSrc = this.sanitizer.bypassSecurityTrustResourceUrl(this.serverInfo.url);
      this.hostStatus = 'ready';
    } catch (error) {
      this.hostStatus = 'error';
      this.errorMessage = error instanceof Error ? error.message : String(error || '');
    }
  }
}
