import { Injectable } from '@angular/core';
import { ActionService } from './action.service';
import { BrowserService } from './browser.service';
import { UiService } from './ui.service';

@Injectable({
  providedIn: 'root'
})
export class UploaderService {

  constructor(
    private actionService: ActionService,
    private browserService: BrowserService,
    private uiService: UiService
  ) { }

  async upload() {
    try {
      this.uiService.sendToolSignal('serial-monitor:disconnect');
      const feedback = await this.actionService.dispatchWithFeedback('upload-begin', {}, 300000).toPromise();

      const uploadResult = feedback?.data?.result;
      const uploadSuccess = feedback?.success !== false
        && feedback?.data?.success !== false
        && !!uploadResult
        && uploadResult?.state !== 'error';

      if (!uploadSuccess) {
        const error: any = new Error(uploadResult?.text || feedback?.error || '上传失败');
        error.state = uploadResult?.state || 'error';
        error.text = uploadResult?.text || feedback?.error || '上传失败';
        error.result = uploadResult;
        throw error;
      }

      if (!this.browserService.isWindowFocused()) {
        this.browserService.notify('上传', uploadResult?.text || '');
      }
      return uploadResult;
    } catch (error: any) {
      if (!this.browserService.isWindowFocused()) {
        this.browserService.notify('上传', error?.text || error?.message || '上传失败');
      }
      throw error;
    } finally {
      this.uiService.sendToolSignal('serial-monitor:connect');
    }
  }

  /**
  * 取消当前编译过程
  */
  cancel() {
    this.actionService.dispatch('upload-cancel', {}, result => {
      if (result.success) {
      } else {
      }
    });
  }

  /**
   * 烧录 softdevice 到 nRF5 设备
   * @param softdeviceName softdevice 名称，如 "s110" 或 "none"
   * @param serialPort 串口名称
   * @returns Promise 表示烧录结果
   */
  async flashSoftdevice(softdeviceName: string, serialPort: string): Promise<{ success: boolean; message: string }> {
    try {
      this.uiService.sendToolSignal('serial-monitor:disconnect');
      const result = await this.actionService.dispatchWithFeedback('flash-softdevice', {
        softdeviceName,
        serialPort
      }, 300000).toPromise();
      
      if (!this.browserService.isWindowFocused()) {
        const message = result.data?.result?.success ? 'SoftDevice 烧录成功' : 'SoftDevice 烧录失败';
        this.browserService.notify('烧录', message);
      }
      this.uiService.sendToolSignal('serial-monitor:connect');
      return result.data?.result || { success: false, message: '烧录失败' };
    } catch (error: any) {
      if (!this.browserService.isWindowFocused()) {
        this.browserService.notify('烧录', 'SoftDevice 烧录失败');
      }
      this.uiService.sendToolSignal('serial-monitor:connect');
      return { success: false, message: error.message || '烧录失败' };
    }
  }
}

