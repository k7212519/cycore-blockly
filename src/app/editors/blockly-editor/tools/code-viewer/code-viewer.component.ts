import { Component, OnDestroy } from '@angular/core';
import { ToolContainerComponent } from '../../../../components/tool-container/tool-container.component';
import { UiService } from '../../../../services/ui.service';
import { SubWindowComponent } from '../../../../components/sub-window/sub-window.component';
import { Router } from '@angular/router';
import { CommonModule } from '@angular/common';
import { NzCodeEditorModule } from 'ng-zorro-antd/code-editor';
import { FormsModule } from '@angular/forms';
import { BlocklyService } from '../../services/blockly.service';
import { Subject, combineLatest } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { BlockCodeMapping } from '../../components/blockly/generators/arduino/arduino';
import { ThemeService } from '../../../../services/theme.service';
import { ProjectService } from '../../../../services/project.service';
import { NzModalService } from 'ng-zorro-antd/modal';
import { NzMessageService } from 'ng-zorro-antd/message';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';
import { arduinoGenerator } from '../../components/blockly/generators/arduino/arduino';

@Component({
  selector: 'app-code-viewer',
  imports: [
    NzCodeEditorModule,
    ToolContainerComponent,
    SubWindowComponent,
    CommonModule,
    FormsModule,
    NzToolTipModule
  ],
  templateUrl: './code-viewer.component.html',
  styleUrl: './code-viewer.component.scss',
})
export class CodeViewerComponent implements OnDestroy {
  code = '';

  currentUrl;

  windowInfo = '代码查看';

  options: any = {
    language: 'cpp',
    theme: 'vs-dark',
    lineNumbers: 'on',
    automaticLayout: true,
    readOnly: true
  }

  // Monaco 编辑器实例
  private editorInstance: any = null;
  private monacoInstance: any = null;
  private oldDecorations: string[] = [];
  private destroy$ = new Subject<void>();
  converting = false;

  constructor(
    private blocklyService: BlocklyService,
    private uiService: UiService,
    private router: Router,
    private themeService: ThemeService,
    private projectService: ProjectService,
    private modal: NzModalService,
    private message: NzMessageService,
  ) {
    this.themeService.theme$
      .pipe(takeUntil(this.destroy$))
      .subscribe((theme) => {
        const monacoTheme = theme === 'light' ? 'vs' : 'vs-dark';
        this.options = { ...this.options, theme: monacoTheme };
        (window as any).monaco?.editor?.setTheme(monacoTheme);
      });
  }

  ngOnInit() {
    this.currentUrl = this.router.url;
  }

  ngAfterViewInit(): void {
    this.blocklyService.codeSubject
      .pipe(takeUntil(this.destroy$))
      .subscribe((code) => {
        setTimeout(() => {
          this.code = code;
        }, 100);
      });

    // 监听选中块 + 代码映射变化，实时高亮
    combineLatest([
      this.blocklyService.selectedBlockSubject,
      this.blocklyService.blockCodeMapSubject
    ])
      .pipe(takeUntil(this.destroy$))
      .subscribe(([blockId, codeMap]) => {
        if (blockId && codeMap.has(blockId)) {
          const mapping = codeMap.get(blockId)!;
          this.highlightBlock(mapping);
        } else {
          this.clearHighlight();
        }
      });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  /**
   * Monaco 编辑器初始化回调，获取编辑器实例
   */
  onEditorInitialized(editor: any): void {
    this.editorInstance = editor;
    this.monacoInstance = (window as any).monaco;
  }

  /**
   * 高亮指定 block 对应的代码行（支持列级精度）
   */
  private highlightBlock(mapping: BlockCodeMapping): void {
    if (!this.editorInstance || !this.monacoInstance) return;

    const monaco = this.monacoInstance;
    const decorations = mapping.lineRanges.map(range => {
      const hasColumns = range.startColumn !== undefined && range.endColumn !== undefined;
      return {
        range: hasColumns
          ? new monaco.Range(range.startLine, range.startColumn, range.endLine, range.endColumn)
          : new monaco.Range(range.startLine, 1, range.endLine, 1),
        options: {
          isWholeLine: !hasColumns,
          className: hasColumns ? 'block-highlight-inline' : 'block-highlight-line',
          overviewRuler: {
            color: '#FFD54F88',
            position: monaco.editor.OverviewRulerLane.Full
          },
          minimap: {
            color: '#FFD54F88',
            position: monaco.editor.MinimapPosition.Inline
          }
        }
      };
    });

    this.oldDecorations = this.editorInstance.deltaDecorations(
      this.oldDecorations,
      decorations
    );

    // 滚动到第一个高亮区域
    if (mapping.lineRanges.length > 0) {
      this.editorInstance.revealLineInCenter(mapping.lineRanges[0].startLine);
    }
  }

  /**
   * 清除所有高亮
   */
  private clearHighlight(): void {
    if (!this.editorInstance) return;
    this.oldDecorations = this.editorInstance.deltaDecorations(
      this.oldDecorations,
      []
    );
  }

  close() {
    this.uiService.closeTool('code-viewer');
  }

  openProfessionalModeConfirm(): void {
    if (this.converting) {
      return;
    }
    if (!this.projectService.isServerProject) {
      this.message.warning('当前仅支持云端项目切换专业模式');
      return;
    }

    this.modal.confirm({
      nzTitle: '切换为专业模式',
      nzContent: '确认后当前项目将不再支持图形化编程，仅支持代码编辑。系统会删除图形化相关文件，此操作无法撤销。',
      nzOkText: '确认切换',
      nzOkDanger: true,
      nzCancelText: '取消',
      nzOnOk: () => this.convertToProfessionalMode()
    });
  }

  private async convertToProfessionalMode(): Promise<void> {
    this.converting = true;
    try {
      const saveResult = await this.projectService.save();
      if (!saveResult.success) {
        throw new Error(saveResult.error || '保存图形化项目失败');
      }
      const code = this.getCurrentCode();
      const projectInfo = await this.projectService.convertServerProjectToProfessionalMode(code);
      this.message.success('已切换为专业模式');
      this.uiService.closeTool('code-viewer');
      await this.projectService.projectOpenById(projectInfo.projectId);
    } catch (error: any) {
      console.error('切换专业模式失败:', error);
      this.message.error(error?.message || '切换专业模式失败');
      throw error;
    } finally {
      this.converting = false;
    }
  }

  private getCurrentCode(): string {
    if (this.code?.trim()) {
      return this.code;
    }
    try {
      if (this.blocklyService.workspace) {
        return arduinoGenerator.workspaceToCode(this.blocklyService.workspace);
      }
    } catch (error) {
      console.warn('生成专业模式代码失败，使用当前代码视图内容', error);
    }
    return this.code || '';
  }
}
