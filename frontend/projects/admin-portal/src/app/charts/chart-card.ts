import { ChangeDetectionStrategy, Component, input, signal } from '@angular/core';
import { Icon } from '@aerotrack/shared';
import { ChartLine, Table2 } from 'lucide';

/**
 * Card frame for a chart with a chart/table toggle (every chart has a table-view twin).
 * Project the chart into the default slot and the table into [table].
 */
@Component({
  selector: 'ui-chart-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    <header class="card-header">
      <div class="titles">
        <h2>{{ heading() }}</h2>
        @if (subheading()) { <span class="hint">{{ subheading() }}</span> }
      </div>
      @if (toggle()) {
        <div class="seg" role="group" aria-label="View">
          <button type="button" [class.on]="!asTable()" (click)="asTable.set(false)" aria-label="Chart view" title="Chart"><ui-icon [icon]="icons.ChartLine" [size]="15" /></button>
          <button type="button" [class.on]="asTable()" (click)="asTable.set(true)" aria-label="Table view" title="Table"><ui-icon [icon]="icons.Table2" [size]="15" /></button>
        </div>
      }
    </header>
    <div class="body" [class.stale]="stale()">
      @if (asTable()) { <ng-content select="[table]" /> } @else { <ng-content /> }
    </div>
  `,
  styles: `
    :host { display: flex; flex-direction: column; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow-xs); min-width: 0; }
    .titles { display: grid; gap: 2px; }
    .seg { display: inline-flex; padding: 2px; border-radius: 8px; background: var(--gray-100); }
    .seg button { display: grid; place-items: center; width: 30px; height: 26px; border: 0; border-radius: 6px; background: transparent; color: var(--text-3); cursor: pointer; }
    .seg button.on { background: var(--surface); color: var(--text); box-shadow: var(--shadow-sm); }
    .body { padding: 16px 20px 18px; flex: 1; transition: opacity var(--normal) var(--ease); }
    .body.stale { opacity: .55; }
  `,
})
export class ChartCard {
  readonly heading = input.required<string>();
  readonly subheading = input<string>();
  readonly toggle = input(true);
  /** Refetch keeps the frame: dim the previous render instead of flashing a skeleton. */
  readonly stale = input(false);
  protected readonly asTable = signal(false);
  protected readonly icons = { ChartLine, Table2 };
}
