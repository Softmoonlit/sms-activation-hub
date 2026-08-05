import assert from 'node:assert/strict';
import test from 'node:test';

import { countryFlag, countryFlagHtml, formatCurrency, formatDateTime, isoCodeFromEmoji } from '../src/country-flag.js';

test('countryFlag returns corresponding flag emoji for common country names', () => {
  assert.equal(countryFlag('美国'), '🇺🇸');
  assert.equal(countryFlag('英国'), '🇬🇧');
  assert.equal(countryFlag('中国'), '🇨🇳');
  assert.equal(countryFlag('法国'), '🇫🇷');
  assert.equal(countryFlag('哈萨克斯坦'), '🇰🇿');
  assert.equal(countryFlag('印尼'), '🇮🇩');
  assert.equal(countryFlag('ZA 南非'), '🇿🇦');
  assert.equal(countryFlag('ZA'), '🇿🇦');
  assert.equal(countryFlag('US 美国'), '🇺🇸');
  assert.equal(countryFlag('CO 哥伦比亚'), '🇨🇴');
  assert.equal(countryFlag('未知国家'), '🌐');
  assert.equal(countryFlag(undefined), '🌐');
});

test('isoCodeFromEmoji extracts 2-letter ISO code from flag emoji', () => {
  assert.equal(isoCodeFromEmoji('🇨🇴'), 'co');
  assert.equal(isoCodeFromEmoji('🇿🇦'), 'za');
  assert.equal(isoCodeFromEmoji('🇺🇸'), 'us');
  assert.equal(isoCodeFromEmoji('🌐'), undefined);
});

test('countryFlagHtml renders img tag with flagcdn CDN', () => {
  assert.match(countryFlagHtml('CO 哥伦比亚'), /src="https:\/\/flagcdn\.com\/w40\/co\.png"/);
  assert.match(countryFlagHtml('ZA 南非'), /src="https:\/\/flagcdn\.com\/w40\/za\.png"/);
  assert.equal(countryFlagHtml(undefined), '🌐');
});

test('formatCurrency converts numeric ISO currency codes to uppercase currency symbols', () => {
  assert.equal(formatCurrency('840'), 'USD');
  assert.equal(formatCurrency('978'), 'EUR');
  assert.equal(formatCurrency('156'), 'CNY');
  assert.equal(formatCurrency('643'), 'RUB');
  assert.equal(formatCurrency('USD'), 'USD');
  assert.equal(formatCurrency(''), '');
  assert.equal(formatCurrency(undefined), '');
});

test('formatDateTime converts UTC date to compact Beijing time and restores year across years', () => {
  const currentYear = Number(new Intl.DateTimeFormat('en', { timeZone: 'Asia/Shanghai', year: 'numeric' }).format(new Date()));
  assert.equal(formatDateTime(new Date(`${currentYear}-08-01T06:09:36.000Z`)), '08-01 14:09');
  assert.equal(formatDateTime(new Date(`${currentYear - 1}-08-01T06:09:36.000Z`)), `${currentYear - 1}-08-01 14:09`);
  assert.equal(formatDateTime(new Date(`${currentYear - 1}-12-31T16:30:00.000Z`)), '01-01 00:30');
  assert.equal(formatDateTime(new Date(`${currentYear - 1}-12-31T15:59:00.000Z`)), `${currentYear - 1}-12-31 23:59`);
  assert.equal(formatDateTime(undefined), '');
});
