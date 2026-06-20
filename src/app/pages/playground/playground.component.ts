import { Component, EventEmitter, Output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzTagModule } from 'ng-zorro-antd/tag';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { PlaygroundService } from './playground.service';
import { ElectronService } from '../../services/electron.service';

@Component({
  selector: 'app-playground',
  imports: [
    FormsModule,
    NzButtonModule,
    NzTagModule,
    NzInputModule,
    NzToolTipModule,
    TranslateModule,
    RouterModule
  ],
  templateUrl: './playground.component.html',
  styleUrl: './playground.component.scss'
})
export class PlaygroundComponent {
  @Output() close = new EventEmitter();

  tagList: any[] = [];
  board: string = '';
  private returnUrl = '/main/guide';
  // exampleList = []

  constructor(
    private router: Router,
    private route: ActivatedRoute,
    private translate: TranslateService,
    private playgroundService: PlaygroundService,
    private electronService: ElectronService
  ) {

  }

  ngOnInit() {
    // 获取查询参数中的 board
    this.route.queryParams.subscribe(params => {
      this.board = params['board'] || '';
      this.keyword = params['keyword'] || '';
      if (this.isSafeReturnUrl(params['returnUrl'])) {
        this.returnUrl = params['returnUrl'];
      }
    });

    // 使用翻译初始化标签列表
    this.tagList = [
      {
        text: 'SenseCraft AI',
        color: '#739c19ff'
      },
      {
        text: 'AI-VOX',
      },
      {
        text: 'UNO R4',
      },
      {
        text: 'ESP32S3',
      },
      {
        text: '程序设计基础',
      }
    ];

    this.electronService.setTitle('CYCORE-MCU-DevCloud - Playground');
  }

  keyword: string = '';
  search(keyword = this.keyword) {
    this.keyword = keyword || '';
    const queryParams: any = { returnUrl: this.returnUrl };
    if (this.keyword) {
      queryParams.keyword = this.keyword;
    }
    if (this.board) {
      queryParams.board = this.board;
    }
    this.router.navigate(['/main/playground/list'], {
      queryParams
    });
  }

  toggleTag(tag: { text: string }) {
    this.search(this.keyword === tag.text ? '' : tag.text);
  }

  back() {
    void this.router.navigateByUrl(this.returnUrl);
  }

  private isSafeReturnUrl(url: unknown): url is string {
    return typeof url === 'string'
      && url.startsWith('/main/')
      && !url.startsWith('/main/playground');
  }
}
