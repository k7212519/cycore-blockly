import { CommonModule } from '@angular/common';
import { ChangeDetectorRef, Component, EventEmitter, NgZone, OnDestroy, OnInit, Output } from '@angular/core';
import { Subject, combineLatest } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import {
  BLOCKLY_TOOLBOX_SEARCH_KEY,
  BlocklyService,
  BlocklyToolboxFacadeItem,
} from '../../../../services/blockly.service';
import { TranslateModule } from '@ngx-translate/core';

@Component({
  selector: 'app-blockly-toolbox-pane',
  imports: [CommonModule, TranslateModule],
  templateUrl: './blockly-toolbox-pane.component.html',
  styleUrl: './blockly-toolbox-pane.component.scss',
})
export class BlocklyToolboxPaneComponent implements OnInit, OnDestroy {
  @Output() libraryManagerRequested = new EventEmitter<void>();

  readonly searchKey = BLOCKLY_TOOLBOX_SEARCH_KEY;

  items: BlocklyToolboxFacadeItem[] = [];
  selectedKey: string | null = null;
  searchQuery = '';

  private destroy$ = new Subject<void>();

  // get isSearchActive(): boolean {
  //   return this.selectedKey === this.searchKey;
  // }

  constructor(
    private blocklyService: BlocklyService,
    private cdr: ChangeDetectorRef,
    private ngZone: NgZone,
  ) {}

  ngOnInit(): void {
    combineLatest([
      this.blocklyService.toolboxFacadeItemsSubject,
      this.blocklyService.toolboxSelectedKeySubject,
      this.blocklyService.toolboxSearchQuerySubject,
    ])
      .pipe(takeUntil(this.destroy$))
      .subscribe(([items, selectedKey, searchQuery]) => {
        this.ngZone.run(() => {
          this.items = items;
          this.selectedKey = selectedKey;
          this.searchQuery = searchQuery;
          this.cdr.markForCheck();
        });
      });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  trackItem(_index: number, item: BlocklyToolboxFacadeItem): string {
    return item.key;
  }

  onSearchFocus() {
    this.blocklyService.activateToolboxSearch();
  }

  onSearchInput(event: Event) {
    const query = (event.target as HTMLInputElement).value;
    this.blocklyService.setToolboxSearchQuery(query);
  }

  onSearchClear() {
    this.blocklyService.clearToolboxSearch();
  }

  onCategoryClick(item: BlocklyToolboxFacadeItem) {
    this.blocklyService.clickToolboxFacadeItem(item.key);
  }

  onToggleClick(item: BlocklyToolboxFacadeItem, event: MouseEvent) {
    event.stopPropagation();
    this.blocklyService.toggleToolboxFacadeItem(item.key);
  }

  onLibraryManagerClick() {
    this.libraryManagerRequested.emit();
  }
}