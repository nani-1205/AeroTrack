import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { IconNode } from 'lucide';
import { Icon } from './icon';

@Component({
  selector: 'ui-empty-state',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    <span class="ico"><ui-icon [icon]="icon()" [size]="22" /></span>
    <h3>{{ heading() }}</h3>
    @if (description()) { <p>{{ description() }}</p> }
    <ng-content />
  `,
  styles: `
    :host { display: grid; justify-items: center; gap: 8px; padding: 48px 24px; text-align: center; }
    .ico { display: grid; place-items: center; width: 48px; height: 48px; margin-bottom: 4px; border-radius: 14px; color: var(--text-2); background: var(--gray-100); box-shadow: inset 0 0 0 1px var(--border); }
    p { max-width: 36ch; color: var(--text-2); }
  `,
})
export class EmptyState {
  readonly icon = input.required<IconNode>();
  readonly heading = input.required<string>();
  readonly description = input<string>();
}
