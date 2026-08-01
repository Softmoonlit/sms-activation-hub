const COUNTRY_FLAGS: Record<string, string> = {
  '中国': '🇨🇳',
  '美国': '🇺🇸',
  '英国': '🇬🇧',
  '法国': '🇫🇷',
  '德国': '🇩🇪',
  '日本': '🇯🇵',
  '韩国': '🇰🇷',
  '加拿大': '🇨🇦',
  '澳大利亚': '🇦🇺',
  '俄罗斯': '🇷🇺',
  '印度': '🇮🇳',
  '印尼': '🇮🇩',
  '印度尼西亚': '🇮🇩',
  '巴西': '🇧🇷',
  '阿根廷': '🇦🇷',
  '菲律宾': '🇵🇭',
  '越南': '🇻🇳',
  '泰国': '🇹🇭',
  '泰國': '🇹🇭',
  '马来西亚': '🇲🇾',
  '新加坡': '🇸🇬',
  '哈萨克斯坦': '🇰🇿',
  '乌克兰': '🇺🇦',
  '乌兹别克斯坦': '🇺🇿',
  '吉尔吉斯斯坦': '🇰🇬',
  '塔吉克斯坦': '🇹🇯',
  '土耳其': '🇹🇷',
  '埃及': '🇪🇬',
  '南非': '🇿🇦',
  '尼日利亚': '🇳🇬',
  '肯尼亚': '🇰🇪',
  '墨西哥': '🇲🇽',
  '哥伦比亚': '🇨🇴',
  '秘鲁': '🇵🇪',
  '智利': '🇨🇱',
  '西班牙': '🇪🇸',
  '葡萄牙': '🇵🇹',
  '意大利': '🇮🇹',
  '荷兰': '🇳🇱',
  '波兰': '🇵🇱',
  '瑞典': '🇸🇪',
  '挪威': '🇳🇴',
  '芬兰': '🇫🇮',
  '丹麦': '🇩🇰',
  '爱尔兰': '🇮🇪',
  '瑞士': '🇨🇭',
  '奥地利': '🇦🇹',
  '比利时': '🇧🇪',
  '希腊': '🇬🇷',
  '罗马尼亚': '🇷🇴',
  '保加利亚': '🇧🇬',
  '匈牙利': '🇭🇺',
  '捷克': '🇨🇿',
  '斯洛伐克': '🇸🇰',
  '新西兰': '🇳🇿',
  '沙特阿拉伯': '🇸🇦',
  '沙特': '🇸🇦',
  '阿联酋': '🇦🇪',
  '阿拉伯联合酋长国': '🇦🇪',
  '以色列': '🇮🇱',
  '巴基斯坦': '🇵🇰',
  '孟加拉国': '🇧🇩',
  '孟加拉': '🇧🇩',
  '柬埔寨': '🇰🇭',
  '老挝': '🇱🇦',
  '缅甸': '🇲🇲',
  '尼泊尔': '🇳🇵',
  '斯里兰卡': '🇱🇰',
  '摩洛哥': '🇲🇦',
  '阿尔及利亚': '🇩🇿',
  '突尼斯': '🇹🇳',
  '加纳': '🇬🇭',
  '科特迪瓦': '🇨🇮',
  '喀眉隆': '🇨🇲',
  '喀麦隆': '🇨🇲',
  '埃塞俄比亚': '🇪🇹',
  '安哥拉': '🇦🇴',
  '莫桑比克': '🇲🇿',
  '津巴布韦': '🇿🇼', 'ZW': '🇿🇼',
  '摩尔多瓦': '🇲🇩', 'MD': '🇲🇩',
  '亚美尼亚': '🇦🇲', 'AM': '🇦🇲',
  '阿塞拜疆': '🇦🇿', 'AZ': '🇦🇿',
  '格鲁吉亚': '🇬🇪', 'GE': '🇬🇪',
  '蒙古': '🇲🇳', 'MN': '🇲🇳',
  '香港': '🇭🇰', 'HK': '🇭🇰', '中国香港': '🇭🇰',
  '台湾': '🇹🇼', 'TW': '🇹🇼', '中国台湾': '🇹🇼',
  '澳门': '🇲🇴', 'MO': '🇲🇴', '中国澳门': '🇲🇴',
  'CN': '🇨🇳', 'US': '🇺🇸', 'GB': '🇬🇧', 'FR': '🇫🇷', 'DE': '🇩🇪',
  'JP': '🇯🇵', 'KR': '🇰🇷', 'CA': '🇨🇦', 'AU': '🇦🇺', 'RU': '🇷🇺',
  'IN': '🇮🇳', 'ID': '🇮🇩', 'BR': '🇧🇷', 'AR': '🇦🇷', 'PH': '🇵🇭',
  'VN': '🇻🇳', 'TH': '🇹🇭', 'MY': '🇲🇾', 'SG': '🇸🇬', 'KZ': '🇰🇿',
  'UA': '🇺🇦', 'UZ': '🇺🇿', 'KG': '🇰🇬', 'TJ': '🇹🇯', 'TR': '🇹🇷',
  'EG': '🇪🇬', 'ZA': '🇿🇦', 'NG': '🇳🇬', 'KE': '🇰🇪', 'MX': '🇲🇽',
  'CO': '🇨🇴', 'PE': '🇵🇪', 'CL': '🇨🇱', 'ES': '🇪🇸', 'PT': '🇵🇹',
  'IT': '🇮🇹', 'NL': '🇳🇱', 'PL': '🇵🇱', 'SE': '🇸🇪', 'NO': '🇳🇴',
  'FI': '🇫🇮', 'DK': '🇩🇰', 'IE': '🇮🇪', 'CH': '🇨🇭', 'AT': '🇦🇹',
  'BE': '🇧🇪', 'GR': '🇬🇷', 'RO': '🇷🇴', 'BG': '🇧🇬', 'HU': '🇭🇺',
  'CZ': '🇨🇿', 'SK': '🇸🇰', 'NZ': '🇳🇿', 'SA': '🇸🇦', 'AE': '🇦🇪',
  'IL': '🇮🇱', 'PK': '🇵🇰', 'BD': '🇧🇩', 'KH': '🇰🇭', 'LA': '🇱🇦',
  'MM': '🇲🇲', 'NP': '🇳🇵', 'LK': '🇱🇰', 'MA': '🇲🇦', 'DZ': '🇩🇿',
  'TN': '🇹🇳', 'GH': '🇬🇭', 'CI': '🇨🇮', 'CM': '🇨🇲', 'ET': '🇪🇹',
  'AO': '🇦🇴', 'MZ': '🇲🇿',
};

export function countryFlag(name?: string): string {
  if (!name) return '🌐';
  const trimmed = name.trim();
  if (COUNTRY_FLAGS[trimmed]) return COUNTRY_FLAGS[trimmed];
  if (COUNTRY_FLAGS[trimmed.toUpperCase()]) return COUNTRY_FLAGS[trimmed.toUpperCase()];

  const tokens = trimmed.split(/[\s()_,-]+/);
  for (const token of tokens) {
    if (!token) continue;
    const upper = token.toUpperCase();
    if (COUNTRY_FLAGS[token]) return COUNTRY_FLAGS[token];
    if (COUNTRY_FLAGS[upper]) return COUNTRY_FLAGS[upper];
  }

  for (const [key, flag] of Object.entries(COUNTRY_FLAGS)) {
    if (key.length > 1 && (trimmed.includes(key) || key.includes(trimmed))) return flag;
  }
  return '🌐';
}

export function isoCodeFromEmoji(emoji: string): string | undefined {
  const chars = [...emoji];
  if (chars.length !== 2) return undefined;
  const code0 = chars[0].codePointAt(0);
  const code1 = chars[1].codePointAt(0);
  if (!code0 || !code1) return undefined;
  if (code0 >= 0x1F1E6 && code0 <= 0x1F1FF && code1 >= 0x1F1E6 && code1 <= 0x1F1FF) {
    return String.fromCharCode(code0 - 0x1F1E6 + 65, code1 - 0x1F1E6 + 65).toLowerCase();
  }
  return undefined;
}

export function countryFlagHtml(name?: string): string {
  const emoji = countryFlag(name);
  if (emoji === '🌐' || !emoji) return '🌐';
  const iso = isoCodeFromEmoji(emoji);
  if (!iso) return emoji;
  return `<img class="country-flag-img" src="https://flagcdn.com/w40/${iso}.png" srcset="https://flagcdn.com/w80/${iso}.png 2x" width="20" height="15" alt="${emoji}">`;
}

const CURRENCY_DISPLAY_MAP: Record<string, string> = {
  '840': 'USD',
  '978': 'EUR',
  '156': 'CNY',
  '643': 'RUB',
};

export function formatCurrency(currency?: string): string {
  if (!currency) return '';
  const trimmed = currency.trim();
  return CURRENCY_DISPLAY_MAP[trimmed] ?? trimmed;
}

export function formatDateTime(date?: Date): string {
  if (!date || Number.isNaN(date.getTime())) return '';
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  return formatter.format(date).replace(/\//g, '-');
}
