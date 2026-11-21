import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { SERIES_COLORS } from './scale';

export interface BarItem {
  key: string;
  label: string;
  sublabel?: string;
  value: number;
  /** Extra line shown in the hover tooltip. */
  detail?: string;
}

/** Ranked horizontal bars — one series, one colour; value at the bar tip; hover tooltip per bar. */
@Component({
  selector: 'ui-bar-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ol>
      @for (item of items(); track item.key) {
        <li tabindex="0" (pointerenter)="hover.set(item.key)" (pointerleave)="hover.set(null)" (focus)="hover.set(item.key)" (blur)="hover.set(null)"
            [class.on]="hover() === item.key" [attr.aria-label]="item.label + ': ' + format()(item.value) + ' ' + unit()">
          <span class="name"><span class="label">{{ item.label }}</span>@if (item.sublabel) { <span class="sub">{{ item.sublabel }}</span> }</span>
          <span class="track">
            <span class="bar" [style.width.%]="pct(item.value)" [style.background]="color"></span>
            <span class="value">{{ format()(item.value) }}</span>
          </span>
          @if (hover() === item.key) {
            <span class="tip"><b>{{ format()(item.value) }} {{ unit() }}</b><span>{{ item.label }}</span>@if (item.detail) { <span>{{ item.detail }}</span> }</span>
          }
        </li>
      }
    </ol>
  `,
  styles: `
    ol { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
    li { position: relative; display: grid; grid-template-columns: minmax(120px, 38%) 1fr; align-items: center; gap: 12px; padding: 6px 8px; border-radius: 8px; outline: none; }
    li.on { background: var(--gray-50); }
    li:focus-visible { box-shadow: var(--focus-ring); }
    .name { display: grid; min-width: 0; line-height: 1.25; }
    .label { font-weight: 550; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sub { font-size: .75rem; color: var(--text-3); font-family: var(--mono); }
    .track { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .bar { height: 10px; min-width: 3px; border-radius: 0 4px 4px 0; transition: width var(--normal) var(--ease), filter var(--fast); }
    li.on .bar { filter: brightness(1.12); }
    .value { font-size: .82rem; font-weight: 600; font-variant-numeric: tabular-nums; color: var(--text); white-space: nowrap; }
    .tip { position: absolute; z-index: 2; right: 8px; top: -6px; transform: translateY(-100%); display: grid; gap: 1px; padding: 7px 10px; font-size: .78rem; color: var(--text-2); background: var(--surface); border: 1px solid var(--border); border-radius: 8px; box-shadow: var(--shadow-md); pointer-events: none; white-space: nowrap; }
    .tip b { color: var(--text); font-weight: 650; }
  `,
})
export class BarList {
  readonly items = input.required<BarItem[]>();
  readonly unit = input('');
  readonly format = input<(v: number) => string>((v) => new Intl.NumberFormat('en-US').format(v));

  protected readonly color = SERIES_COLORS[0];
  protected readonly hover = signal<string | null>(null);
  private readonly max = computed(() => Math.max(1, ...this.items().map((i) => i.value)));

  protected pct(v: number): number {
    return Math.max(1.5, (v / this.max()) * 78); // leave room for the value label at the tip
  }
}
