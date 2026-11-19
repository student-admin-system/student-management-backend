import { describe, it, expect } from 'vitest';
import { normalizeArabic } from '../utils/arabic';
import { parsePagination, buildPaginatedResponse } from '../utils/pagination';
import { getCairoToday, getCurrentMonth, getCairoDayBounds } from '../utils/date';

describe('Arabic Normalization Utility (FR-STU-04)', () => {
  it('normalizes alef variants (أ إ آ -> ا)', () => {
    expect(normalizeArabic('أحمد')).toBe('احمد');
    expect(normalizeArabic('إبراهيم')).toBe('ابراهيم');
    expect(normalizeArabic('آدم')).toBe('ادم');
  });

  it('normalizes teh marbuta and alef maqsura (ة -> ه, ى -> ي)', () => {
    expect(normalizeArabic('سارة')).toBe('ساره');
    expect(normalizeArabic('منى')).toBe('مني');
    expect(normalizeArabic('علي')).toBe('علي');
  });

  it('removes tashkeel / diacritics', () => {
    expect(normalizeArabic('مُحَمَّدٌ')).toBe('محمد');
  });
});

describe('Pagination Utility', () => {
  it('parses valid and default pagination params safely', () => {
    const defaultParams = parsePagination({});
    expect(defaultParams.page).toBe(1);
    expect(defaultParams.pageSize).toBe(20);

    const custom = parsePagination({ page: '3', pageSize: '15' });
    expect(custom.page).toBe(3);
    expect(custom.pageSize).toBe(15);

    const bounded = parsePagination({ pageSize: '500' });
    expect(bounded.pageSize).toBe(100); // MAX_PAGE_SIZE
  });

  it('builds paginated response with both nested and flat metrics', () => {
    const items = ['a', 'b', 'c'];
    const res = buildPaginatedResponse(items, 45, { page: 2, pageSize: 10 });
    expect(res.data).toEqual(items);
    expect(res.total).toBe(45);
    expect(res.page).toBe(2);
    expect(res.limit).toBe(10);
    expect(res.totalPages).toBe(5);
    expect(res.pagination.totalItems).toBe(45);
    expect(res.pagination.totalPages).toBe(5);
  });
});

describe('Cairo Date Utilities (NFR-01)', () => {
  it('returns valid Cairo YYYY-MM-DD date and YYYY-MM month', () => {
    const today = getCairoToday();
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const month = getCurrentMonth();
    expect(month).toMatch(/^\d{4}-\d{2}$/);
    expect(today.slice(0, 7)).toBe(month);
  });

  it('calculates Cairo day bounds correctly', () => {
    const { start, end } = getCairoDayBounds('2026-11-17');
    expect(start).toBeInstanceOf(Date);
    expect(end).toBeInstanceOf(Date);
    expect(end.getTime()).toBeGreaterThan(start.getTime());
  });
});
