import assert from 'node:assert/strict';
import test from 'node:test';

import { countryCallingCode } from '../src/country-calling-code.js';
import { countryFlag } from '../src/country-flag.js';

const COUNTRY_CALLING_CODES: Record<string, string> = {
  CN: '86', US: '1', GB: '44', FR: '33', DE: '49', JP: '81', KR: '82', CA: '1', AU: '61', RU: '7',
  IN: '91', ID: '62', BR: '55', AR: '54', PH: '63', VN: '84', TH: '66', MY: '60', SG: '65', KZ: '7',
  UA: '380', UZ: '998', KG: '996', TJ: '992', TR: '90', EG: '20', ZA: '27', NG: '234', KE: '254', MX: '52',
  CO: '57', PE: '51', CL: '56', ES: '34', PT: '351', IT: '39', NL: '31', PL: '48', SE: '46', NO: '47',
  FI: '358', DK: '45', IE: '353', CH: '41', AT: '43', BE: '32', GR: '30', RO: '40', BG: '359', HU: '36',
  CZ: '420', SK: '421', NZ: '64', SA: '966', AE: '971', IL: '972', PK: '92', BD: '880', KH: '855', LA: '856',
  MM: '95', NP: '977', LK: '94', MA: '212', DZ: '213', TN: '216', GH: '233', CI: '225', CM: '237', ET: '251',
  AO: '244', MZ: '258', ZW: '263', MD: '373', AM: '374', AZ: '994', GE: '995', MN: '976', HK: '852', TW: '886',
  MO: '853',
};

test('countryCallingCode returns calling codes for representative country names', () => {
  assert.equal(countryCallingCode('美国'), '1');
  assert.equal(countryCallingCode('英国'), '44');
  assert.equal(countryCallingCode('法国'), '33');
  assert.equal(countryCallingCode('中国'), '86');
  assert.equal(countryCallingCode('俄罗斯'), '7');
});

test('countryCallingCode covers every ISO2 region supported by country flags', () => {
  const supportedIso2Codes = Array.from({ length: 26 * 26 }, (_, index) => {
    const first = String.fromCharCode(65 + Math.floor(index / 26));
    const second = String.fromCharCode(65 + (index % 26));
    return `${first}${second}`;
  }).filter((isoCode) => countryFlag(isoCode) !== '🌐');

  assert.deepEqual(Object.keys(COUNTRY_CALLING_CODES).sort(), supportedIso2Codes.sort());

  for (const [isoCode, callingCode] of Object.entries(COUNTRY_CALLING_CODES)) {
    assert.equal(countryCallingCode(isoCode), callingCode, isoCode);
  }
});

test('countryCallingCode returns undefined for unknown or missing country names', () => {
  assert.equal(countryCallingCode('未知地区'), undefined);
  assert.equal(countryCallingCode(''), undefined);
  assert.equal(countryCallingCode(undefined), undefined);
});
