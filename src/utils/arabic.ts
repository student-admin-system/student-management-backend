/**
 * Normalize Arabic text for search:
 * - أ / إ / آ → ا
 * - ة → ه
 * - ى → ي
 * - Strip tashkeel (diacritics) in Unicode range \u064B-\u065F and \u0670
 */
export function normalizeArabic(text: string): string {
  return text
    .replace(/[\u0623\u0625\u0622]/g, '\u0627') // أ إ آ → ا
    .replace(/\u0629/g, '\u0647')               // ة → ه
    .replace(/\u0649/g, '\u064A')               // ى → ي
    .replace(/[\u064B-\u065F\u0670]/g, '');     // strip diacritics
}
