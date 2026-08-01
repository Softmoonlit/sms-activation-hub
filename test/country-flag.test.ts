import assert from 'node:assert/strict';
import test from 'node:test';

import { countryFlag, formatCurrency } from '../src/country-flag.js';

test('countryFlag returns corresponding flag emoji for common country names', () => {
  assert.equal(countryFlag('美国'), '🇺🇸');
  assert.equal(countryFlag('英国'), '🇬🇧');
  assert.equal(countryFlag('中国'), '🇨🇳');
  assert.equal(countryFlag('法国'), '🇫🇷');
  assert.equal(countryFlag('哈萨克斯坦'), '🇰🇿');
  assert.equal(countryFlag('印尼'), '🇮🇩');
  assert.equal(countryFlag('未知国家'), '🌐');
  assert.equal(countryFlag(undefined), '🌐');
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
