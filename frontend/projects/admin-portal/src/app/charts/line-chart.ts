import {
  ChangeDetectionStrategy, Component, DestroyRef, ElementRef, afterNextRender, computed, inject, input, signal,
} from '@angular/core';
import { axisLabel, niceTicks, tickIndices } from './scale';

export interface LineSeries {
  key: string;
  label: string;
  color: string;
  values: (number | null)[];
}

const M = { top: 12, right: 16, bottom: 28 };
const LABEL_GAP = 14;

/**
 * Multi-series line chart (one y-axis). Crosshair + tooltip on hover/keyboard, legend for
 * ≥2 series, selective end labels (dropped when they would collide), hairline solid grid.
 */
@Component({
  selector: 'ui-line-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (series().length > 1) {
      <ul class="legend">
        @for (s of series(); track s.key) { <li><i [style.background]="s.color"></i>{{ s.label }}</li> }
      </ul>
    }
    <div class="plot" [style.height.px]="height()">
      @if (width() > 0) {
        <svg [attr.width]="width()" [attr.height]="height()" role="img" [attr.aria-label]="ariaLabel()" tabindex="0"
             (keydown)="onKey($event)" (blur)="hover.set(null)">
          @for (t of yTicks(); track t) {
            <line class="grid" [attr.x1]="left()" [attr.x2]="width() - M.right" [attr.y1]="y(t)" [attr.y2]="y(t)" />
            <text class="ytick" [attr.x]="left() - 8" [attr.y]="y(t)" dy="0.32em">{{ yLabel(t) }}</text>
          }
          <line class="axis" [attr.x1]="left()" [attr.x2]="width() - M.right" [attr.y1]="y(0)" [attr.y2]="y(0)" />
          @for (i of xTicks(); track i) {
            <text class="xtick" [attr.x]="x(i)" [attr.y]="height() - 8" [attr.text-anchor]="i === 0 ? 'start' : i === n() - 1 ? 'end' : 'middle'">{{ xFormat()(i) }}</text>
          }
          @for (s of series(); track s.key) {
            <path class="line" [attr.d]="path(s.values)" [attr.stroke]="s.color" />
          }
          @for (e of endLabels(); track e.key) {
            <circle class="dot" [attr.cx]="e.x" [attr.cy]="e.y" r="4" [attr.fill]="e.color" />
            @if (showEndLabels()) { <text class="end" [attr.x]="e.x + 8" [attr.y]="e.y" dy="0.32em">{{ e.text }}</text> }
          }
          @if (hover(); as i) {
            <line class="cross" [attr.x1]="x(i)" [attr.x2]="x(i)" [attr.y1]="M.top" [attr.y2]="y(0)" />
            @for (s of series(); track s.key) {
              @if (s.values[i] != null) { <circle class="dot" [attr.cx]="x(i)" [attr.cy]="y(s.values[i]!)" r="4" [attr.fill]="s.color" /> }
            }
          }
          <rect class="hit" [attr.x]="left()" [attr.y]="0" [attr.width]="plotW()" [attr.height]="height()"
                (pointermove)="onMove($event)" (pointerleave)="hover.set(null)" />
        </svg>
      }
      @if (hover(); as i) {
        <div class="tip" [style.left.px]="tipX(i)" [style.top.px]="M.top">
          <div class="tip-head">{{ tooltipLabel()(i) }}</div>
          @for (s of series(); track s.key) {
            <div class="tip-row"><b>{{ s.values[i] == null ? '—' : valueFormat()(s.values[i]!) }}</b><span><i [style.background]="s.color"></i>{{ s.label }}</span></div>
          }
        </div>
      }
    </div>
  `,
  styles: `
    :host { display: block; }
    .legend { list-style: none; display: flex; flex-wrap: wrap; gap: 6px 16px; margin: 0 0 12px; padding: 0; font-size: .8rem; color: var(--text-2); }
    .legend li { display: inline-flex; align-items: center; gap: 6px; }
    .legend i { width: 14px; height: 2px; border-radius: 2px; }
    .plot { position: relative; }
    svg { display: block; overflow: visible; outline: none; }
    svg:focus-visible { box-shadow: var(--focus-ring); border-radius: 6px; }
    .grid { stroke: var(--gray-200); stroke-width: 1; shape-rendering: crispEdges; }
    .axis { stroke: var(--gray-300); stroke-width: 1; shape-rendering: crispEdges; }
    .ytick, .xtick { font-size: 11px; fill: var(--text-3); font-variant-numeric: tabular-nums; }
    .ytick { text-anchor: end; }
    .line { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
    .dot { stroke: var(--surface); stroke-width: 2; }
    .end { font-size: 11px; font-weight: 600; fill: var(--text-2); }
    .cross { stroke: var(--gray-400); stroke-width: 1; shape-rendering: crispEdges; pointer-events: none; }
    .hit { fill: transparent; cursor: crosshair; }
    .tip {
      position: absolute; z-index: 2; min-width: 150px; padding: 8px 10px; pointer-events: none;
      background: var(--surface); border: 1px solid var(--border); border-radius: 10px; box-shadow: var(--shadow-md); font-size: .8rem;
    }
    .tip-head { margin-bottom: 4px; color: var(--text-3); font-size: .75rem; }
    .tip-row { display: flex; justify-content: space-between; gap: 12px; align-items: center; padding: 1px 0; }
    .tip-row b { font-weight: 650; color: var(--text); font-variant-numeric: tabular-nums; }
    .tip-row span { display: inline-flex; align-items: center; gap: 6px; color: var(--text-2); }
    .tip-row i { width: 12px; height: 2px; border-radius: 2px; }
  `,
})
export class LineChart {
  readonly series = input.required<LineSeries[]>();
  readonly height = input(220);
  /** Tick label for point i. */
  readonly xFormat = input<(i: number) => string>((i) => String(i));
  /** Tooltip heading for point i (defaults to the tick label). */
  readonly xTooltip = input<((i: number) => string) | null>(null);
  readonly valueFormat = input<(v: number) => string>((v) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(v));
  readonly ariaLabel = input('Line chart');

  protected readonly M = M;
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  protected readonly width = signal(0);
  protected readonly hover = signal<number | null>(null);

  protected readonly n = computed(() => Math.max(0, ...this.series().map((s) => s.values.length)));
  private readonly max = computed(() => Math.max(0, ...this.series().flatMap((s) => s.values.filter((v): v is number => v != null))));
  protected readonly yTicks = computed(() => niceTicks(this.max()));
  private readonly top = computed(() => this.yTicks().at(-1) ?? 1);
  /** Left margin sized to the widest y label. */
  protected readonly left = computed(() => 12 + 7 * Math.max(...this.yTicks().map((t) => this.yLabel(t).length)));
  protected readonly plotW = computed(() => Math.max(10, this.width() - this.left() - M.right));
  protected readonly xTicks = computed(() => tickIndices(this.n(), this.width() < 480 ? 4 : 6));
  protected readonly tooltipLabel = computed(() => this.xTooltip() ?? this.xFormat());

  protected readonly endLabels = computed(() =>
    this.series().flatMap((s) => {
      for (let i = s.values.length - 1; i >= 0; i--) {
        const v = s.values[i];
        if (v != null) return [{ key: s.key, x: this.x(i), y: this.y(v), color: s.color, text: this.valueFormat()(v) }];
      }
      return [];
    }),
  );
  /** Direct end labels only when they don't collide (else legend + tooltip carry identity). */
  protected readonly showEndLabels = computed(() => {
    const ys = this.endLabels().map((e) => e.y).sort((a, b) => a - b);
    return this.series().length <= 4 && ys.every((y, i) => i === 0 || y - ys[i - 1]! >= LABEL_GAP);
  });

  constructor() {
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      if (typeof ResizeObserver === 'undefined') {
        this.width.set(this.host.clientWidth || 600); // non-browser environments (tests)
        return;
      }
      const ro = new ResizeObserver(([entry]) => this.width.set(Math.floor(entry!.contentRect.width)));
      ro.observe(this.host);
      destroyRef.onDestroy(() => ro.disconnect());
    });
  }

  protected x(i: number): number {
    const n = this.n();
    return this.left() + (n <= 1 ? this.plotW() / 2 : (i * this.plotW()) / (n - 1));
  }

  protected y(v: number): number {
    const plotH = this.height() - M.top - M.bottom;
    return M.top + plotH * (1 - v / this.top());
  }

  protected yLabel(v: number): string {
    return axisLabel(v, this.yTicks().at(-1) ?? 0);
  }

  protected path(values: (number | null)[]): string {
    let d = '';
    let pen = false;
    values.forEach((v, i) => {
      if (v == null) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${this.x(i).toFixed(1)},${this.y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  }

  protected tipX(i: number): number {
    const x = this.x(i);
    return x > this.width() - 190 ? x - 172 : x + 12;
  }

  protected onMove(e: PointerEvent): void {
    const n = this.n();
    if (n === 0) return;
    const rect = (e.currentTarget as SVGRectElement).ownerSVGElement!.getBoundingClientRect();
    const px = e.clientX - rect.left - this.left();
    this.hover.set(Math.min(n - 1, Math.max(0, Math.round((px / this.plotW()) * (n - 1)))));
  }

  protected onKey(e: KeyboardEvent): void {
    const n = this.n();
    if (!n || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const cur = this.hover() ?? n - 1;
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : cur + (e.key === 'ArrowLeft' ? -1 : 1);
    this.hover.set(Math.min(n - 1, Math.max(0, next)));
  }
}
