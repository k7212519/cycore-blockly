import { Injectable } from '@angular/core';
import { ProjectService } from './project.service';
import { ActionState } from './ui.service';
import { NzMessageService } from 'ng-zorro-antd/message';
import { NoticeService } from '../services/notice.service';
import { ActionService } from './action.service';
import { BrowserService } from './browser.service';


@Injectable({
  providedIn: 'root'
})
export class BuilderService {

  constructor(
    private actionService: ActionService,
    private projectService: ProjectService,
    private browserService: BrowserService
  ) {
    this.init();
  }

  private init(): void {
    this.projectService.boardChangeSubject.subscribe(() => {
      try {
        this.actionService.dispatch('compile-reset', {}, result => {
          console.log('编译器已重置:', result);
        });
      } catch (error) {
        console.warn('编译器重置失败:', error);
      }

    });
  }

  /*
   * 开始编译
   */
  async build() {
    try {
      const feedback = await this.actionService.dispatchWithFeedback('compile-begin', {}, 600000).toPromise();

      // listener handler 内部 catch 了编译错误，所以 feedback.success 总是 true
      // 需要检查 data.success 来判断编译是否真正成功
      const buildResult = feedback?.data?.result;
      const buildSuccess = feedback?.success !== false
        && feedback?.data?.success !== false
        && !!buildResult
        && buildResult?.state !== 'error';

      if (!this.browserService.isWindowFocused()) {
        this.browserService.notify('编译', buildResult?.text || '');
      }

      if (!buildSuccess) {
        // 编译失败，构造包含状态和错误详情的错误对象抛出
        const error: any = new Error(buildResult?.text || feedback?.error || '编译失败');
        error.state = buildResult?.state || 'error';
        error.text = buildResult?.text || feedback?.error || '编译失败';
        error.fullStdErr = buildResult?.fullStdErr;
        error.buildResult = buildResult;
        throw error;
      }

      return buildResult;
    } catch (error: any) {
      // console.error('编译失败:', error);
      if (!this.browserService.isWindowFocused()) {
        this.browserService.notify('编译', error?.text || error?.message || '编译失败');
      }
      throw error;
    }
  }

  /*
   * 取消当前编译过程
   */
  cancel() {
    this.actionService.dispatch('compile-cancel', {}, result => {
      if (result.success) {
      } else {
      }
    });
  }

  /**
   * 触发预编译操作
   * 用于配置变更后触发自动预编译
   * @param reason 触发原因，用于日志记录
   */
  triggerPreprocess(reason: string = 'manual') {
    console.log(`触发预编译操作，原因: ${reason}`);
    this.actionService.dispatch('preprocess-trigger', { reason }, result => {
      if (result.success) {
        console.log('预编译触发成功');
      } else {
        console.warn('预编译触发失败:', result);
      }
    });
  }

}
