import { Component, OnInit, ViewChild, ElementRef, AfterViewInit, OnDestroy } from '@angular/core';
import { RouterModule } from '@angular/router';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { TranslateModule } from '@ngx-translate/core';
import { ActivatedRoute } from '@angular/router';
import { NzPaginationModule } from 'ng-zorro-antd/pagination';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';
import { NzMessageService } from 'ng-zorro-antd/message';
import { firstValueFrom, Subject, Subscription } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { CloudService } from '../../../tools/cloud-space/services/cloud.service';
import { ProjectService } from '../../../services/project.service';
import { BrowserService } from '../../../services/browser.service';
import { Buffer } from 'buffer';
import { jsonrepair } from 'jsonrepair';

@Component({
  selector: 'app-example-list',
  imports: [
    RouterModule,
    CommonModule,
    FormsModule,
    NzInputModule,
    NzButtonModule,
    TranslateModule,
    NzPaginationModule,
    NzToolTipModule
  ],
  templateUrl: './example-list.component.html',
  styleUrl: './example-list.component.scss'
})
export class ExampleListComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('contentBox', { static: false }) contentBox!: ElementRef;
  
  exampleList: any[] = [];
  keyword: string = '';
  id: string = '';
  board: string = '';
  params: any = {};
  version: string = '';
  sessionId: string = '';
  isOpened: boolean = false;

  pageIndex: number = 1; // 当前页码
  pageSize: number = 10; // 每页显示数量，默认值
  total: number = 500; // 总条目数
  loadingExampleIndex: number | null = null; // 当前正在加载的示例索引
  
  private destroy$ = new Subject<void>();
  private examplesSub: Subscription | null = null;

  constructor(
    private route: ActivatedRoute,
    private cloudService: CloudService,
    private projectService: ProjectService,
    private browserService: BrowserService,
    private messageService: NzMessageService
  ) {
  }

  parseParams(paramsStr: string): any {
    try {
      if (!paramsStr || paramsStr.trim() === '') {
        return {};
      }
      // 兼容处理：将 URL 中的空格替换回 + (防止被错误解码)
      const base64Str = paramsStr.replace(/ /g, '+');
      let jsonStr = Buffer.from(base64Str, 'base64').toString('utf8');
      
      // 尝试修复 JSON 字符串中的控制字符和格式问题
      try {
        jsonStr = jsonrepair(jsonStr);
      } catch (err) {
        console.warn('jsonrepair failed, trying raw parse', err);
        // 兜底：移除可能导致解析错误的不可见控制字符
        jsonStr = jsonStr.replace(/[\x00-\x1F]+/g, "");
      }

      if (jsonStr.startsWith("'") && jsonStr.endsWith("'")) {
        jsonStr = jsonStr.substring(1, jsonStr.length - 1);
      }
      const paramsObj = JSON.parse(jsonStr);
      return paramsObj;
    } catch (e) {
      console.error('解析params失败:', e);
      return {};
    }
  }

  ngOnInit() {
    // 订阅 URL 参数变化并在每次变化时获取示例列表。
    // queryParams 会立即发出当前值，因此不需要额外的初始 getExamples() 调用，
    // 这样可以避免组件创建时重复请求。
    this.route.queryParams
      .pipe(takeUntil(this.destroy$))
      .subscribe(params => {
        // console.log('URL参数:', params);
        this.id = params['id'] || '';
        this.sessionId = params['sessionId'] || '';
        this.board = params['board'] || '';

        this.keyword = params['keyword'] || '';
        this.params = this.parseParams(params['params'] || '');

        this.version = params['version'] || '';
        // 当通过 URL 搜索时，重置回第一页
        this.pageIndex = 1;
        this.getExamples();
      });
  }

  getExamples() {
    if (this.examplesSub) {
      this.examplesSub.unsubscribe();
    }
    this.examplesSub = this.cloudService.getPublicProjects(this.pageIndex, this.pageSize, this.keyword, this.id, this.board)
      .pipe(takeUntil(this.destroy$))
      .subscribe(res => {
      if (res && res.status === 200) {
        this.exampleList = []
        this.total = res.data.total;
        
        res.data.list.forEach(prj => {
          const imageUrl = this.cloudService.resolveCloudFileUrl(prj.image_url);
          const imageVersion = prj.updated_at || prj.updatedAt || '';
          prj.image_url = imageUrl
            ? `${imageUrl}${imageUrl.includes('?') ? '&' : '?'}v=${encodeURIComponent(imageVersion)}`
            : 'imgs/project-placeholder.svg';
          prj.archive_url = this.cloudService.resolveCloudFileUrl(prj.archive_url);
          this.exampleList.push(prj);
        });

        console.log('获取公开项目列表:', this.exampleList);
        if (this.exampleList.length === 0 && this.pageIndex === 1) {
          this.messageService.warning("No examples found.");
          return;
        }

        if (this.id && !this.isOpened) {
          this.isOpened = true;
          this.loadExample(0);
        }
      }
    });
  }

  ngAfterViewInit() {
    // 初始计算可显示的数量
    setTimeout(() => {
      this.calculatePageSize();
    }, 100);

    // 监听 content-box 元素的大小变化
    if (this.contentBox) {
      const resizeObserver = new ResizeObserver(() => {
        this.calculatePageSize();
      });
      
      resizeObserver.observe(this.contentBox.nativeElement);
      
      // 在组件销毁时断开观察
      this.destroy$.subscribe(() => {
        resizeObserver.disconnect();
      });
    }
  }

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
  }

  /**
   * 计算容器中可以显示多少个示例项
   * 每个示例项：280px x 280px，间距10px
   */
  calculatePageSize() {
    if (!this.contentBox) return;

    const container = this.contentBox.nativeElement;
    const containerWidth = container.clientWidth - 30; // 减去padding (15px * 2)
    const containerHeight = container.clientHeight - 30; // 减去padding (15px * 2)

    const itemWidth = 280;
    const itemHeight = 280;
    const gap = 15; // 根据scss中的gap值

    // 计算每行可以显示多少个
    const itemsPerRow = Math.floor((containerWidth + gap) / (itemWidth + gap));
    
    // 计算可以显示多少行
    const rows = Math.floor((containerHeight + gap) / (itemHeight + gap));

    // 总共可以显示的数量
    const calculatedPageSize = Math.max(1, itemsPerRow * rows);
    
    // console.log('Container size:', containerWidth, 'x', containerHeight);
    // console.log('Items per row:', itemsPerRow, 'Rows:', rows, 'Calculated page size:', calculatedPageSize);
    
    // 如果计算出的 pageSize 与当前值不同,更新并重新获取数据
    if (this.pageSize !== calculatedPageSize) {
      const oldPageSize = this.pageSize;
      this.pageSize = calculatedPageSize;
      // console.log(`Page size changed from ${oldPageSize} to ${this.pageSize}, refreshing data...`);
      
      // 重置到第一页并重新获取数据
      this.pageIndex = 1;
      this.getExamples();
    }
  }

  onImgError(event) {
    (event.target as HTMLImageElement).src = 'imgs/project-placeholder.svg';
  }

  async loadExample(index: number) {
    // 设置当前加载的示例索引
    this.loadingExampleIndex = index;

    const item = this.exampleList[index];
    if (!item?.archive_url) {
      this.messageService.error('项目归档文件不存在');
      this.loadingExampleIndex = null;
      return;
    }

    try {
      const archive = await firstValueFrom(this.cloudService.getProjectArchiveBlob(item.archive_url));
      const created = await this.projectService.importPublicProject(archive, {
        name: item.name || `public_project_${item.id || Date.now()}`,
        nickname: item.nickname,
        description: item.description,
        docUrl: item.doc_url,
        tags: this.parseTags(item.tags)
      });
      await this.projectService.projectOpenById(created.projectId);
    } catch (error) {
      console.error('导入公开项目失败:', error);
      this.messageService.error('加载项目失败: ' + (error?.message || '未知错误'));
    } finally {
      this.loadingExampleIndex = null;
    }
  }

  isLoading(index: number): boolean {
    return this.loadingExampleIndex === index;
  }

  isDisabled(index: number): boolean {
    return this.loadingExampleIndex !== null && this.loadingExampleIndex !== index;
  }

  openDoc(index: number) {
    const item = this.exampleList[index];
    if (item.doc_url && item.doc_url.trim() !== '') {
      this.browserService.openUrl(item.doc_url);
    }
  }

  private parseTags(tags: unknown): string[] {
    if (Array.isArray(tags)) {
      return tags.map(tag => String(tag)).filter(Boolean);
    }
    if (typeof tags !== 'string' || !tags.trim()) {
      return [];
    }
    try {
      const parsed = JSON.parse(tags);
      return Array.isArray(parsed) ? parsed.map(tag => String(tag)).filter(Boolean) : [];
    } catch {
      return tags.split(',').map(tag => tag.trim()).filter(Boolean);
    }
  }

  onPageChange(page: number) {
    console.log('页码变化:', page);
    this.pageIndex = page;
    this.getExamples();
  }
}
