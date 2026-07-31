export type HeroSmsErrorKind = 'authentication' | 'provider' | 'request' | 'response';

export class HeroSmsResponseError extends Error {
  constructor(readonly kind: HeroSmsErrorKind) {
    super(messageFor(kind));
  }
}

export interface HeroSmsService {
  code: string;
  name: string;
}

export interface HeroSmsCountry {
  id: number;
  name: string;
}

export interface HeroSmsQuote {
  countryId: number;
  price: number;
  stock: number;
}

export interface HeroSms {
  balance(): Promise<number>;
  services(): Promise<HeroSmsService[]>;
  countries(): Promise<HeroSmsCountry[]>;
  quotes(serviceCode: string): Promise<HeroSmsQuote[]>;
}

export interface HeroSmsHttpAdapterOptions {
  apiKey: string;
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
}

function messageFor(kind: HeroSmsErrorKind): string {
  switch (kind) {
    case 'authentication':
      return 'HeroSMS 认证失败';
    case 'request':
      return 'HeroSMS 请求无效';
    case 'provider':
      return 'HeroSMS 暂时不可用';
    case 'response':
      return 'HeroSMS 返回了无法识别的响应';
  }
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function errorKind(value: unknown): HeroSmsErrorKind | undefined {
  if (value === 'NO_KEY' || value === 'BAD_KEY') {
    return 'authentication';
  }
  if (typeof value === 'string' && /^(BAD_ACTION|ERROR|NO_ACTIVATION|NO_SERVICE|INVALID_)/.test(value)) {
    return 'request';
  }
  if (value && typeof value === 'object' && 'status' in value && value.status === 'false') {
    const message = 'msg' in value ? value.msg : undefined;
    return typeof message === 'string' && /key|auth/i.test(message) ? 'authentication' : 'request';
  }
  return undefined;
}

function parseBody(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text.trim();
  }
}

function objectEntries(value: unknown): [string, unknown][] | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value) : undefined;
}

export class HeroSmsHttpAdapter implements HeroSms {
  private readonly fetch: typeof globalThis.fetch;

  constructor(private readonly options: HeroSmsHttpAdapterOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async balance(): Promise<number> {
    const value = await this.request('getBalance');
    const match = typeof value === 'string' ? /^ACCESS_BALANCE:(\d+(?:\.\d+)?)$/.exec(value) : undefined;
    if (!match) {
      throw new HeroSmsResponseError('response');
    }
    return Number(match[1]);
  }

  async services(): Promise<HeroSmsService[]> {
    const value = await this.request('getServicesList');
    const entries = objectEntries(value);
    if (!entries) {
      throw new HeroSmsResponseError('response');
    }
    const fields = Object.fromEntries(entries);
    if (fields.status !== 'success' || !Array.isArray(fields.services)) {
      throw new HeroSmsResponseError('response');
    }
    const services = fields.services.map((service: unknown): HeroSmsService | undefined => {
      const entries = objectEntries(service);
      if (!entries) {
        return undefined;
      }
      const fields = Object.fromEntries(entries);
      const code = nonEmptyString(fields.code);
      const name = nonEmptyString(fields.name);
      return code && name ? { code, name } : undefined;
    });
    if (services.some((service) => !service)) {
      throw new HeroSmsResponseError('response');
    }
    return services as HeroSmsService[];
  }

  async countries(): Promise<HeroSmsCountry[]> {
    const value = await this.request('getCountries');
    if (!Array.isArray(value)) {
      throw new HeroSmsResponseError('response');
    }
    const countries = value.map((country): HeroSmsCountry | undefined => {
      const entries = objectEntries(country);
      if (!entries) {
        return undefined;
      }
      const fields = Object.fromEntries(entries);
      const id = nonNegativeNumber(fields.id);
      const name = nonEmptyString(fields.chn);
      return id !== undefined && Number.isInteger(id) && name ? { id, name } : undefined;
    });
    if (countries.some((country) => !country)) {
      throw new HeroSmsResponseError('response');
    }
    return countries as HeroSmsCountry[];
  }

  async quotes(serviceCode: string): Promise<HeroSmsQuote[]> {
    const value = await this.request('getPrices', { service: serviceCode });
    const records = Array.isArray(value) ? value : [value];
    const quotes: HeroSmsQuote[] = [];
    for (const record of records) {
      const entries = objectEntries(record);
      if (!entries) {
        throw new HeroSmsResponseError('response');
      }
      for (const [country, quote] of entries) {
        const countryId = Number(country);
        const fields = objectEntries(quote);
        const price = fields ? nonNegativeNumber(Object.fromEntries(fields).cost) : undefined;
        const stock = fields ? nonNegativeNumber(Object.fromEntries(fields).count) : undefined;
        if (!Number.isInteger(countryId) || countryId < 0 || price === undefined || stock === undefined || !Number.isInteger(stock)) {
          throw new HeroSmsResponseError('response');
        }
        quotes.push({ countryId, price, stock });
      }
    }
    return quotes;
  }

  private async request(action: string, parameters: Record<string, string> = {}): Promise<unknown> {
    const url = new URL(this.options.baseUrl);
    url.search = new URLSearchParams({ action, api_key: this.options.apiKey, ...parameters }).toString();

    let response: Response;
    try {
      response = await this.fetch(url);
    } catch {
      throw new HeroSmsResponseError('provider');
    }

    const value = parseBody(await response.text());
    const returnedError = errorKind(value);
    if (returnedError) {
      throw new HeroSmsResponseError(returnedError);
    }
    if (!response.ok) {
      throw new HeroSmsResponseError(response.status === 401 ? 'authentication' : 'provider');
    }
    return value;
  }
}
