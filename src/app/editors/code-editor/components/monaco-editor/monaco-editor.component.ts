import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output, SimpleChanges, ViewChild, OnDestroy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NzCodeEditorModule, NzCodeEditorComponent } from 'ng-zorro-antd/code-editor';
import { NzMessageService } from 'ng-zorro-antd/message';
import { Subject, takeUntil } from 'rxjs';
import { ThemeService } from '../../../../services/theme.service';

@Component({
  selector: 'app-monaco-editor',
  imports: [
    NzCodeEditorModule,
    CommonModule,
    FormsModule
  ],
  templateUrl: './monaco-editor.component.html',
  styleUrl: './monaco-editor.component.scss'
})
export class MonacoEditorComponent implements OnDestroy {

  @ViewChild(NzCodeEditorComponent) codeEditor: NzCodeEditorComponent;

  @Input() options: any = {
    language: 'cpp',
    theme: 'vs-dark',
    lineNumbers: 'on',
    automaticLayout: true
  }

  @Input() code = '';
  @Input() filePath = ''; // 当前文件路径

  @Output() codeChange = new EventEmitter<string>();
  @Output() openFileRequest = new EventEmitter<{ filePath: string, position: any }>();
  @Output() editorShortcut = new EventEmitter<'save' | 'close'>();

  @Input() sdkPath: string;
  @Input() librariesPath: string;

  private disposables: any[] = [];
  private destroy$ = new Subject<void>();
  public monacoInstance: any;

  constructor(
    private message: NzMessageService,
    private themeService: ThemeService,
  ) {
    this.themeService.theme$
      .pipe(takeUntil(this.destroy$))
      .subscribe((theme) => this.applyTheme(theme));
  }

  ngOnInit() {
  }

  ngAfterViewInit() {
  }

  ngOnChanges(changes: SimpleChanges): void {
  }

  ngOnDestroy() {
    this.disposables.forEach(d => d.dispose());
    this.destroy$.next();
    this.destroy$.complete();
  }

  onCodeChange(newCode: string): void {
    this.codeChange.emit(newCode);
  }

  editorInitialized(editor: any): void {
    this.monacoInstance = editor;

    // 在编辑器初始化后设置Tab键处理
    if (editor) {
      // 添加自定义右键菜单项
      this.setupContextMenu(editor);
      this.setupEditorShortcutPriority(editor);
    }
  }

  private setupEditorShortcutPriority(editor: any): void {
    const domNode = editor?.getDomNode?.();
    if (!domNode) {
      return;
    }

    const listener = (event: KeyboardEvent) => {
      if (!this.isEditorPriorityShortcut(event)) {
        return;
      }

      event.stopPropagation();
      const shortcut = this.normalizeShortcut(event);
      if (shortcut === 'ctrl+s') {
        event.preventDefault();
        this.editorShortcut.emit('save');
      } else if (shortcut === 'ctrl+w') {
        event.preventDefault();
        this.editorShortcut.emit('close');
      }
    };

    domNode.addEventListener('keydown', listener);
    this.disposables.push({
      dispose: () => domNode.removeEventListener('keydown', listener)
    });
  }

  private isEditorPriorityShortcut(event: KeyboardEvent): boolean {
    const key = event.key.toLowerCase();
    const isFunctionKey = /^f([1-9]|1[0-2])$/.test(key);
    return event.ctrlKey || event.metaKey || event.altKey || isFunctionKey;
  }

  private normalizeShortcut(event: KeyboardEvent): string {
    const parts: string[] = [];
    if (event.ctrlKey || event.metaKey) {
      parts.push('ctrl');
    }
    if (event.shiftKey) {
      parts.push('shift');
    }
    if (event.altKey) {
      parts.push('alt');
    }

    const key = event.key.toLowerCase();
    if (!['control', 'shift', 'alt', 'meta'].includes(key)) {
      parts.push(key);
    }
    return parts.join('+');
  }

  private applyTheme(theme: 'dark' | 'light'): void {
    const monacoTheme = theme === 'light' ? 'vs' : 'vs-dark';
    this.options = { ...this.options, theme: monacoTheme };
    (window as any).monaco?.editor?.setTheme(monacoTheme);
  }

  /**
   * 设置自定义右键菜单
   */
  private setupContextMenu(editor: any): void {
    if (!this.monacoInstance) return;
  }

  /**
   * 获取编辑器的视图状态（包含滚动位置、光标位置等）
   */
  public getViewState(): any {
    if (this.monacoInstance && this.monacoInstance.getModel()) {
      try {
        const viewState = this.monacoInstance.saveViewState();
        // console.log('获取视图状态成功:', viewState);
        return viewState;
      } catch (error) {
        console.warn('获取视图状态失败:', error);
        return null;
      }
    } else {
      console.warn('编辑器实例或模型未准备好，无法获取视图状态');
      return null;
    }
  }

  /**
   * 恢复编辑器的视图状态
   */
  public restoreViewState(viewState: any): void {
    if (!viewState) return;
    if (this.monacoInstance && this.monacoInstance.getModel()) {
      try {
        this.monacoInstance.restoreViewState(viewState);
        console.log('视图状态恢复成功');
      } catch (error) {
        console.warn('恢复视图状态失败:', error);
      }
    } else {
      console.warn('编辑器实例或模型未准备好，无法恢复视图状态');
    }
  }

  /**
   * 安全地恢复编辑器状态，会等待编辑器准备就绪
   */
  public async restoreViewStateSafely(viewState: any): Promise<boolean> {
    if (!viewState) return false;

    return new Promise((resolve) => {
      const maxAttempts = 20;
      let attempts = 0;

      const tryRestore = () => {
        if (this.monacoInstance && this.monacoInstance.getModel()) {
          try {
            this.monacoInstance.restoreViewState(viewState);
            console.log('视图状态安全恢复成功');
            resolve(true);
            return;
          } catch (error) {
            console.warn('恢复视图状态失败:', error);
          }
        }

        attempts++;
        if (attempts < maxAttempts) {
          setTimeout(tryRestore, 50);
        } else {
          console.warn('视图状态恢复超时');
          resolve(false);
        }
      };

      tryRestore();
    });
  }

}
