import { ChangeDetectionStrategy, Component, ElementRef, effect, inject, input } from '@angular/core';
import type { IconNode } from 'lucide';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Lucide icon renderer. Pass the icon node itself (tree-shakeable):
 *   import { Plane } from 'lucide';   <ui-icon [icon]="Plane" [size]="16" />
 */
@Component({
  selector: 'ui-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '',
  host: { 'aria-hidden': 'true', style: 'display:inline-flex;flex:none;line-height:0' },
})
export class Icon {
  readonly icon = input.required<IconNode>();
  readonly size = input(16);
  readonly strokeWidth = input(2);

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  constructor() {
    effect(() => {
      const svg = document.createElementNS(SVG_NS, 'svg');
      const size = String(this.size());
      for (const [k, v] of Object.entries({
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        'stroke-width': String(this.strokeWidth()), 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      })) svg.setAttribute(k, v);
      for (const [tag, attrs] of this.icon()) {
        const child = document.createElementNS(SVG_NS, tag);
        for (const [k, v] of Object.entries(attrs)) if (v != null) child.setAttribute(k, String(v));
        svg.appendChild(child);
      }
      this.host.replaceChildren(svg);
    });
  }
}
