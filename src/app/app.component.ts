import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { Router, RouterOutlet } from '@angular/router';
import { CommonModule } from '@angular/common';
import { NzMessageService } from 'ng-zorro-antd/message';
import { Subscription } from 'rxjs';
import { ConfigService } from './services/config.service';
import { TranslationService } from './services/translation.service';
import { EdaAuthService } from './auth/eda-auth.service';
import { ThemeService } from './services/theme.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, CommonModule],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent implements OnInit, OnDestroy {
  title = 'CYCORE-MCU-DevCloud';

  private configService = inject(ConfigService);
  private translationService = inject(TranslationService);
  private edaAuthService = inject(EdaAuthService);
  private themeService = inject(ThemeService);
  private router = inject(Router);
  private message = inject(NzMessageService);
  private sessionInvalidatedSubscription = new Subscription();

  async ngOnInit() {
    this.sessionInvalidatedSubscription = this.edaAuthService.sessionInvalidated$.subscribe(
      reason => this.handleSessionInvalidated(reason)
    );
    await this.configService.init();
    this.themeService.initialize();
    await this.translationService.init();
    await this.edaAuthService.initialize();
  }

  ngOnDestroy(): void {
    this.sessionInvalidatedSubscription.unsubscribe();
  }

  private handleSessionInvalidated(reason: string): void {
    const redirect = this.router.url.startsWith('/login') ? null : this.router.url;
    this.message.warning(reason, { nzDuration: 6000 });
    void this.router.navigate(['/login'], {
      queryParams: redirect ? { redirect } : undefined,
    });
  }
}
