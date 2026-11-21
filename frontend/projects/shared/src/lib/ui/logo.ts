import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { Plane } from 'lucide';
import { Icon } from './icon';

/** Brand lock-up: gradient mark + wordmark (+ optional product tag). */
@Component({
  selector: 'ui-logo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    <span class="mark"><ui-icon [icon]="plane" [size]="markSize() * 0.58" [strokeWidth]="2.2" /></span>
    <span class="word" [style.font-size.px]="markSize() * 0.56">Aero<b>Track</b></span>
    @if (tag()) { <span class="tag">{{ tag() }}</span> }
  `,
  styles: `
    :host { display: inline-flex; align-items: center; gap: 10px; color: var(--text); }
    :host(.on-dark) { color: var(--shell-text); }
    .mark {
      display: grid; place-items: center; flex: none;
      width: calc(var(--s) * 1px); height: calc(var(--s) * 1px); border-radius: 28%;
      color: #fff; background: linear-gradient(135deg, #2563eb 0%, #22d3ee 100%);
      box-shadow: 0 4px 14px -4px rgba(37, 99, 235, .6), inset 0 1px 0 rgba(255, 255, 255, .25);
    }
    .mark ui-icon { transform: rotate(-45deg) translate(1px, 0); }
    .word { font-weight: 500; letter-spacing: -0.02em; }
    .word b { font-weight: 750; }
    .tag {
      font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase;
      padding: 3px 8px; border-radius: 999px; color: var(--text-2); background: var(--gray-100);
    }
    :host(.on-dark) .tag { color: var(--shell-muted); background: rgba(255, 255, 255, .08); }
  `,
  host: { '[style.--s]': 'markSize()' },
})
export class Logo {
  readonly tag = input<string>();
  readonly markSize = input(32);
  protected readonly plane = Plane;
}
