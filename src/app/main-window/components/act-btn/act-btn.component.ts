import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, OnDestroy, Output, SimpleChanges } from '@angular/core';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'app-act-btn',
  imports: [CommonModule, FormsModule],
  templateUrl: './act-btn.component.html',
  styleUrl: './act-btn.component.scss'
})
export class ActBtnComponent implements OnDestroy {
  @Input() icon: string;
  @Input() color: string = '#FFF';
  @Input() state: 'default' | 'doing' | 'done' | 'error' | 'warn' = 'default';
  @Input() noBorder: boolean = false;

  @Output() stateChange = new EventEmitter<'default' | 'doing' | 'done' | 'error' | 'warn'>();

  constructor() {
  }

  ngOnInit() {

  }

  toWink = false;
  private resetTimer?: ReturnType<typeof setTimeout>;
  private winkStartTimer?: ReturnType<typeof setTimeout>;
  private winkEndTimer?: ReturnType<typeof setTimeout>;

  ngOnChanges(changes: SimpleChanges) {
    if (changes['state']) {
      this.clearTimers();
      this.toWink = false;
      if (this.state != 'doing' && this.state != 'default') {
        this.resetTimer = setTimeout(() => {
          this.stateChange.emit('default');
          this.toWink = false;
        }, 6000);
      }
      if (this.state == 'done') {
        this.winkStartTimer = setTimeout(() => {
          this.toWink = true;
          this.winkEndTimer = setTimeout(() => {
            this.toWink = false;
          }, 1000);
        }, 1000);
      }
    }
  }

  ngOnDestroy(): void {
    this.clearTimers();
  }

  private clearTimers(): void {
    if (this.resetTimer) clearTimeout(this.resetTimer);
    if (this.winkStartTimer) clearTimeout(this.winkStartTimer);
    if (this.winkEndTimer) clearTimeout(this.winkEndTimer);
    this.resetTimer = undefined;
    this.winkStartTimer = undefined;
    this.winkEndTimer = undefined;
  }
}
