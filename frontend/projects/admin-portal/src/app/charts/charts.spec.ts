import { TestBed } from '@angular/core/testing';
import { BarList } from './bar-list';
import { LineChart } from './line-chart';
import { axisLabel, niceTicks, tickIndices } from './scale';

describe('chart scales', () => {
  it('produces round ticks that cover the maximum', () => {
    expect(niceTicks(4)).toEqual([0, 1, 2, 3, 4]);
    expect(niceTicks(0.23)).toEqual([0, 0.1, 0.2, 0.3]);
    expect(niceTicks(1660)).toEqual([0, 500, 1000, 1500, 2000]);
    expect(niceTicks(0)).toEqual([0, 1]);
  });

  it('formats axis labels in full below 10,000 and compact above', () => {
    expect(axisLabel(2000, 3000)).toBe('2,000');
    expect(axisLabel(20000, 40000)).toBe('20K');
  });

  it('spreads x ticks evenly and keeps both ends', () => {
    expect(tickIndices(3)).toEqual([0, 1, 2]);
    expect(tickIndices(25, 6)).toEqual([0, 5, 10, 14, 19, 24]);
  });
});

describe('LineChart', () => {
  it('draws one path per series, a legend for ≥2 series and gaps for missing values', async () => {
    const fixture = TestBed.createComponent(LineChart);
    fixture.componentRef.setInput('series', [
      { key: 'a', label: 'Sign-ins', color: '#2a78d6', values: [1, 2, null, 4] },
      { key: 'b', label: 'Sessions', color: '#eb6834', values: [0, 1, 1, 2] },
    ]);
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const paths = el.querySelectorAll('path.line');
    expect(paths.length).toBe(2);
    expect(paths[0]!.getAttribute('d')!.match(/M/g)!.length).toBe(2); // null splits the line
    expect([...el.querySelectorAll('.legend li')].map((li) => li.textContent?.trim())).toEqual(['Sign-ins', 'Sessions']);
  });

  it('shows every series value at the hovered point (keyboard)', async () => {
    const fixture = TestBed.createComponent(LineChart);
    fixture.componentRef.setInput('series', [
      { key: 'a', label: 'Gateway', color: '#2a78d6', values: [0.1, 0.2] },
      { key: 'b', label: 'Auth', color: '#eb6834', values: [0.3, 0.4] },
    ]);
    await fixture.whenStable();
    fixture.detectChanges();
    const svg = (fixture.nativeElement as HTMLElement).querySelector('svg')!;
    svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'End' }));
    fixture.detectChanges();
    const rows = [...(fixture.nativeElement as HTMLElement).querySelectorAll('.tip-row')].map((r) => [
      r.querySelector('b')?.textContent?.trim(),
      r.querySelector('span')?.textContent?.trim(),
    ]);
    expect(rows).toEqual([['0.2', 'Gateway'], ['0.4', 'Auth']]);
  });
});

describe('BarList', () => {
  it('renders ranked bars with the value at each tip', async () => {
    const fixture = TestBed.createComponent(BarList);
    fixture.componentRef.setInput('items', [
      { key: 'AIC', label: 'Air India', value: 12 },
      { key: 'BAW', label: 'British Airways', value: 6 },
    ]);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    expect([...el.querySelectorAll('.value')].map((v) => v.textContent)).toEqual(['12', '6']);
    const widths = [...el.querySelectorAll<HTMLElement>('.bar')].map((b) => parseFloat(b.style.width));
    expect(widths[0]).toBeGreaterThan(widths[1]!);
  });
});
