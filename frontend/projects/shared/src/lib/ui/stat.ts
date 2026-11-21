import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { IconNode } from 'lucide';
import { Icon } from './icon';

/** KPI tile: label, big value, optional hint and icon. */
@Component({
  selector: 'ui-stat',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    <div class="top">
      <span class="label">{{ label() }}</span>
      @if (icon(); as i) { <span class="ico"><ui-icon [icon]="i" [size]="16" /></span> }
    </div>
    @if (loading()) {
      <span class="skeleton value-skel"></span>
    } @else {
      <div class="value tabular">{{ value() }}<ng-content select="[unit]" /></div>
    }
    @if (hint()) { <div class="hint">{{ hint() }}</div> }
    <ng-content />
  `,
  styles: `
    :host { display: grid; gap: 6px; align-content: start; padding: 18px 20px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow-xs); min-width: 0; }
    .top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .label { font-size: .8rem; font-weight: 550; color: var(--text-2); }
    .ico { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 8px; color: var(--accent); background: var(--accent-soft); }
    .value { font-size: 1.75rem; font-weight: 650; letter-spacing: -.03em; color: var(--text); line-height: 1.15; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .value-skel { width: 55%; height: 30px; }
    .hint { font-size: .8rem; color: var(--text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  `,
})
export class Stat {
  readonly label = input.required<string>();
  readonly value = input<string | number | null>(null);
  readonly hint = input<string | null>(null);
  readonly icon = input<IconNode | null>(null);
  readonly loading = input(false);
}
