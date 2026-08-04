import { countryFlag, isoCodeFromEmoji } from './country-flag.js';

const CALLING_CODE_BY_ISO2: Readonly<Record<string, string>> = {
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

export function countryCallingCode(countryName?: string): string | undefined {
  const iso2 = isoCodeFromEmoji(countryFlag(countryName));
  return iso2 ? CALLING_CODE_BY_ISO2[iso2.toUpperCase()] : undefined;
}
