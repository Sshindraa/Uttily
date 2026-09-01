import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DatesPanel } from './dates-panel';
import { initialSelection } from './search-state';

describe('DatesPanel', () => {
  it('renders inclusive dates without making up pickup times', () => {
    const html = renderToStaticMarkup(
      <DatesPanel
        locale="fr"
        selection={{ ...initialSelection(), startDate: '2026-09-12', endDate: '2026-09-13' }}
        onChange={() => {}}
        onDone={() => {}}
      />,
    );
    expect(html).toContain('Dernier jour');
    expect(html).toContain('Premier et dernier jours inclus');
    expect(html).not.toContain('type="time"');
    expect(html).toContain('aria-label="samedi 12 septembre 2026"');
  });

  it('keeps both optional time inputs empty until the user chooses their hours', () => {
    const html = renderToStaticMarkup(
      <DatesPanel
        locale="en"
        selection={{ ...initialSelection(), withTimes: true }}
        onChange={() => {}}
        onDone={() => {}}
      />,
    );
    expect(html.match(/type="time"/g)).toHaveLength(2);
    expect(html).toContain('Local pickup times');
    expect(html).not.toContain('value="09:00"');
  });

  it('does not crash when a user types the last supported calendar month', () => {
    expect(() =>
      renderToStaticMarkup(
        <DatesPanel
          locale="fr"
          selection={{ ...initialSelection(), startDate: '9999-12-01', endDate: '9999-12-31' }}
          onChange={() => {}}
          onDone={() => {}}
        />,
      ),
    ).not.toThrow();
  });
});
