import { Component, Input } from '@angular/core';
import { Router } from '@angular/router';

@Component({
  selector: 'app-sub-window',
  imports: [],
  templateUrl: './sub-window.component.html',
  styleUrl: './sub-window.component.scss',
})
export class SubWindowComponent {
  @Input() title = 'sub-window';
  @Input() winBtns = ['go-main', 'close'];

  currentUrl;

  constructor(
    private router: Router,
  ) {}

  ngOnInit(): void {
    this.currentUrl = this.router.url;
  }

  goMain() {
    this.router.navigate(['/main/guide']);
  }

  close() {
    history.length > 1 ? history.back() : this.router.navigate(['/main/guide']);
  }
}
