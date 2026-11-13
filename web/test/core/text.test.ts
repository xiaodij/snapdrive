import { describe, expect, it } from 'vitest';
import { documentText, plainText, suggestedTitle } from '../../src/core/text';
import type { RecognizedLine } from '../../src/core/types';

const line = (text: string, x: number, y: number, confidence = 0.9, height = 0.02): RecognizedLine => ({
  text,
  box: { x, y, width: 0.2, height },
  confidence,
});

describe('plainText', () => {
  it('reads top to bottom (bottom-left boxes), then left to right within a row', () => {
    const lines = [
      line('Amount', 0.7, 0.7),
      line('Description', 0.1, 0.7),
      line('Total', 0.1, 0.5),
      line('INVOICE', 0.1, 0.9),
      line('Qty', 0.5, 0.703), // same row as Description, slightly offset
    ];
    expect(plainText(lines)).toBe('INVOICE\nDescription\nQty\nAmount\nTotal');
  });

  it('separates pages in multi-page text', () => {
    expect(documentText([[line('A', 0, 0.5)], [line('B', 0, 0.5)]])).toBe('--- Page 1 ---\nA\n\n--- Page 2 ---\nB');
    expect(documentText([[line('A', 0, 0.5)]])).toBe('A');
  });
});

describe('suggestedTitle', () => {
  it('takes the highest title-shaped line', () => {
    expect(
      suggestedTitle([line('Atlanta Industry Supply', 0.1, 0.85), line('INVOICE 2026-0814', 0.1, 0.9), line('p.1', 0.9, 0.95)]),
    ).toBe('INVOICE 2026-0814');
  });

  it('skips short, long, letterless and low-confidence lines and cleans path characters', () => {
    expect(
      suggestedTitle([
        line('123', 0.1, 0.99),
        line('2026/08/14 12:30', 0.1, 0.98),
        line('x'.repeat(61), 0.1, 0.97),
        line('Blurry heading', 0.1, 0.96, 0.4),
        line('Invoice: A/B "draft"', 0.1, 0.95),
      ]),
    ).toBe('Invoice- A-B -draft-');
  });

  it('returns null when nothing qualifies', () => {
    expect(suggestedTitle([])).toBeNull();
    expect(suggestedTitle([line('---', 0, 0.5)])).toBeNull();
  });
});

describe('suggestedTitle (v2 noise rejection)', () => {
  it('skips logo noise that is mostly punctuation or has no real word', () => {
    const lines = [line('- ems ll @ -', 0.1, 0.95, 0.62), line('em @', 0.1, 0.93, 0.7), line('INVOICE 2026-0814', 0.1, 0.9)];
    expect(suggestedTitle(lines)).toBe('INVOICE 2026-0814');
  });
  it('accepts short CJK titles', () => {
    expect(suggestedTitle([line('发票编号', 0.1, 0.9)])).toBe('发票编号');
    expect(suggestedTitle([line('T4 (2019)', 0.1, 0.9)])).toBe('T4 (2019)');
  });
});
