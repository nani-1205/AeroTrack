import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/** Stable hue per code, so an airline always gets the same colour. */
export function hueOf(code: string): number {
  let h = 0;
  for (const ch of code) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

/** Coloured initials tile (airline codes, users). */
@Component({
  selector: 'ui-monogram',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `{{ text() }}`,
  styles: `
    :host {
      display: inline-grid; place-items: center; flex: none;
      width: var(--size); height: var(--size); border-radius: 28%;
      font: 700 calc(var(--size) * .34)/1 var(--mono); letter-spacing: -.02em;
      color: hsl(var(--hue) 55% 32%);
      background: linear-gradient(160deg, hsl(var(--hue) 85% 96%), hsl(var(--hue) 75% 90%));
      box-shadow: inset 0 0 0 1px hsl(var(--hue) 50% 82%);
    }
  `,
  host: { '[style.--hue]': 'hue()', '[style.--size]': 'size() + "px"', '[attr.aria-hidden]': 'true' },
})
export class Monogram {
  /** Code that drives the colour (e.g. ICAO). */
  readonly code = input.required<string>();
  /** Text shown (defaults to the code). */
  readonly label = input<string | null>();
  readonly size = input(40);

  protected readonly text = computed(() => (this.label() || this.code()).slice(0, 3));
  protected readonly hue = computed(() => hueOf(this.code()));
}
