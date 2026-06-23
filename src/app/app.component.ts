import { Component, OnInit, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { CommonModule } from '@angular/common';
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
export class AppComponent implements OnInit {
  title = 'CYCORE-MCU-DevCloud';

  private configService = inject(ConfigService);
  private translationService = inject(TranslationService);
  private edaAuthService = inject(EdaAuthService);
  private themeService = inject(ThemeService);

  async ngOnInit() {
    await this.configService.init();
    this.themeService.initialize();
    await this.translationService.init();
    await this.edaAuthService.initialize();
  }
}
