export type HeroSmsErrorKind =
  | 'authentication'
  | 'balance'
  | 'account'
  | 'no-numbers'
  | 'rate-limit'
  | 'provider'
  | 'request'
  | 'response'
  | 'uncertain';

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

export interface HeroSmsNumber {
  activationId: string;
  phoneNumber?: string;
  activationCost?: number;
  currency?: string;
  activationTime?: Date;
  activationEndTime?: Date;
}

export interface HeroSmsActivationRecord {
  activationId: string;
  phoneNumber: string;
  activationCost: number;
  currency: string;
  serviceCode?: string;
  countryId?: number;
  activationTime?: Date;
  status: string;
}

export interface HeroSmsActivationStatus {
  delivered: boolean;
  providerStatus?: 'cancelled';
  receivedAt?: Date;
  code?: string;
  text?: string;
}

export type HeroSmsCancellationResult = 'cancelled' | 'sms-delivered' | 'too-early';

export interface HeroSms {
  balance(): Promise<number>;
  services(): Promise<HeroSmsService[]>;
  countries(): Promise<HeroSmsCountry[]>;
  quotes(serviceCode: string): Promise<HeroSmsQuote[]>;
  getNumber(serviceCode: string, countryId: number): Promise<HeroSmsNumber>;
  activeActivations(): Promise<HeroSmsActivationRecord[]>;
  activationHistory(start: Date, end: Date): Promise<HeroSmsActivationRecord[]>;
  activationStatus(activationId: string): Promise<HeroSmsActivationStatus>;
  cancelActivation(activationId: string): Promise<HeroSmsCancellationResult>;
  finishActivation(activationId: string): Promise<void>;
}

export interface HeroSmsHttpAdapterOptions {
  apiKey: string;
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  requestTimeoutMs?: number;
}

function messageFor(kind: HeroSmsErrorKind): string {
  switch (kind) {
    case 'authentication':
      return 'HeroSMS 认证失败';
    case 'balance':
      return 'HeroSMS 余额不足';
    case 'account':
      return 'HeroSMS 账号不可用';
    case 'no-numbers':
      return 'HeroSMS 当前无可用号码';
    case 'rate-limit':
      return 'HeroSMS 请求过于频繁';
    case 'request':
      return 'HeroSMS 请求无效';
    case 'provider':
      return 'HeroSMS 暂时不可用';
    case 'response':
      return 'HeroSMS 返回了无法识别的响应';
    case 'uncertain':
      return 'HeroSMS 请求结果不确定';
  }
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function errorCode(value: unknown): string | undefined {
  if (typeof value === 'string') return value.split(':', 1)[0];
  if (value && typeof value === 'object' && 'title' in value && typeof value.title === 'string') return value.title;
  return undefined;
}

function errorKind(value: unknown): HeroSmsErrorKind | undefined {
  const code = errorCode(value);
  if (code === 'NO_NUMBERS') return 'no-numbers';
  if (code === 'NO_BALANCE') return 'balance';
  if (code === 'NO_KEY' || code === 'BAD_KEY') return 'authentication';
  if (code === 'ACCOUNT_INACTIVE' || code === 'CHANNELS_LIMIT') return 'account';
  if (code === 'RATE_LIMIT') return 'rate-limit';
  if (code === 'SERVER_ERROR' || code === 'ERROR_SQL') return 'provider';
  if (code && /^(BAD_|WRONG_|INVALID_|NO_ACTIVATION|NO_SERVICE|ERROR$)/.test(code)) return 'request';
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

export function parseSupplierDate(value: unknown): Date | undefined {
  if (typeof value !== 'string' || /^0{4}-0{2}-0{2}/.test(value)) return undefined;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(' ', 'T')}+03:00` : value;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function activationRecord(value: unknown, active: boolean): HeroSmsActivationRecord | undefined {
  const entries = objectEntries(value);
  if (!entries) return undefined;
  const fields = Object.fromEntries(entries);
  const activationId = nonEmptyString(active ? fields.activationId : fields.id);
  const phoneNumber = nonEmptyString(active ? fields.phoneNumber : fields.phone);
  const activationCost = nonNegativeNumber(active ? fields.activationCost : fields.cost);
  const currencyValue = fields.currency;
  const currency = typeof currencyValue === 'number' && Number.isFinite(currencyValue)
    ? currencyValue.toString()
    : nonEmptyString(currencyValue);
  const status = nonEmptyString(active ? fields.activationStatus : fields.status);
  const serviceCode = active ? nonEmptyString(fields.serviceCode) : undefined;
  const countryIdValue = active && typeof fields.countryCode === 'string' ? Number(fields.countryCode) : fields.countryCode;
  const countryId = active ? nonNegativeNumber(countryIdValue) : undefined;
  if (!activationId || !phoneNumber || activationCost === undefined || !currency || !status
    || (active && (!serviceCode || countryId === undefined || !Number.isInteger(countryId)))) return undefined;
  return {
    activationId, phoneNumber, activationCost, currency, status,
    ...(serviceCode ? { serviceCode } : {}),
    ...(countryId !== undefined ? { countryId } : {}),
    activationTime: parseSupplierDate(active ? fields.activationTime : fields.date),
  };
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
    const countryValues = Array.isArray(value)
      ? value
      : objectEntries(value)?.map(([, country]) => country);
    if (!countryValues) {
      throw new HeroSmsResponseError('response');
    }
    const countries = countryValues.map((country): HeroSmsCountry | undefined => {
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
        const quoteFields = objectEntries(quote);
        const quoteObject = quoteFields ? Object.fromEntries(quoteFields) : undefined;
        const serviceQuote = quoteObject && objectEntries(quoteObject[serviceCode])
          ? Object.fromEntries(objectEntries(quoteObject[serviceCode])!)
          : quoteObject;
        const price = serviceQuote ? nonNegativeNumber(serviceQuote.cost) : undefined;
        const stock = serviceQuote ? nonNegativeNumber(serviceQuote.count) : undefined;
        if (!Number.isInteger(countryId) || countryId < 0 || price === undefined || stock === undefined || !Number.isInteger(stock)) {
          throw new HeroSmsResponseError('response');
        }
        quotes.push({ countryId, price, stock });
      }
    }
    return quotes;
  }

  async getNumber(serviceCode: string, countryId: number): Promise<HeroSmsNumber> {
    let value: unknown;
    try {
      value = await this.request('getNumberV2', { service: serviceCode, country: countryId.toString() });
    } catch (error) {
      if (error instanceof HeroSmsResponseError && error.kind === 'response') throw new HeroSmsResponseError('uncertain');
      throw error;
    }
    if (typeof value === 'string') {
      const match = /^ACCESS_NUMBER:([^:]+):(.+)$/.exec(value);
      if (!match?.[1] || !match[2]) throw new HeroSmsResponseError('uncertain');
      return { activationId: match[1], phoneNumber: match[2] };
    }
    const entries = objectEntries(value);
    if (!entries) throw new HeroSmsResponseError('uncertain');
    const fields = Object.fromEntries(entries);
    const activationId = nonEmptyString(fields.activationId);
    const phoneNumber = nonEmptyString(fields.phoneNumber);
    const activationCost = nonNegativeNumber(fields.activationCost);
    const currencyValue = fields.currency;
    const currency = typeof currencyValue === 'number' && Number.isFinite(currencyValue)
      ? currencyValue.toString()
      : nonEmptyString(currencyValue);
    const activationTime = parseSupplierDate(fields.activationTime);
    const activationEndTime = parseSupplierDate(fields.activationEndTime);
    if (!activationId || !phoneNumber
      || (fields.activationCost !== undefined && activationCost === undefined)
      || (fields.currency !== undefined && !currency)
      || (fields.activationTime !== undefined && !activationTime)
      || (fields.activationEndTime !== undefined && !activationEndTime)) {
      throw new HeroSmsResponseError('uncertain');
    }
    return {
      activationId, phoneNumber,
      ...(activationCost !== undefined ? { activationCost } : {}),
      ...(currency ? { currency } : {}),
      ...(activationTime ? { activationTime } : {}),
      ...(activationEndTime ? { activationEndTime } : {}),
    };
  }

  async activationStatus(activationId: string): Promise<HeroSmsActivationStatus> {
    const value = await this.request('getStatusV2', { id: activationId });
    if (value === 'STATUS_WAIT_CODE') return { delivered: false };
    if (value === 'STATUS_CANCEL') return { delivered: false, providerStatus: 'cancelled' };
    const fields = objectEntries(value) ? Object.fromEntries(objectEntries(value)!) : undefined;
    const smsFields = fields && objectEntries(fields.sms) ? Object.fromEntries(objectEntries(fields.sms)!) : undefined;
    if (!smsFields) throw new HeroSmsResponseError('response');
    const code = nonEmptyString(smsFields.code);
    const text = nonEmptyString(smsFields.text);
    const receivedAt = parseSupplierDate(smsFields.dateTime);
    if (!text) throw new HeroSmsResponseError('response');
    return { delivered: true, text, ...(code ? { code } : {}), ...(receivedAt ? { receivedAt } : {}) };
  }

  async cancelActivation(activationId: string): Promise<HeroSmsCancellationResult> {
    const result = await this.request('cancelActivation', { id: activationId }, [204], (value, status) => {
      if (status !== 409) return undefined;
      const code = errorCode(value);
      if (code === 'OTP_RECEIVED' || code === 'ACTIVATION_OTP_RECEIVED') return 'sms-delivered';
      if (code === 'EARLY_CANCEL_DENIED') return 'too-early';
      return undefined;
    });
    if (result === undefined) return 'cancelled';
    if (result === 'sms-delivered' || result === 'too-early') return result;
    throw new HeroSmsResponseError('response');
  }

  async finishActivation(activationId: string): Promise<void> {
    await this.request('finishActivation', { id: activationId }, [204]);
  }

  async activeActivations(): Promise<HeroSmsActivationRecord[]> {
    const all: HeroSmsActivationRecord[] = [];
    for (let start = 0; ; start += 100) {
      const value = await this.request('getActiveActivations', { start: start.toString(), limit: '100' });
      const fields = objectEntries(value) ? Object.fromEntries(objectEntries(value)!) : undefined;
      if (!fields || fields.status !== 'success' || !Array.isArray(fields.data)) throw new HeroSmsResponseError('response');
      const records = fields.data.map((item: unknown) => activationRecord(item, true));
      if (records.some((record: HeroSmsActivationRecord | undefined) => !record)) throw new HeroSmsResponseError('response');
      all.push(...records as HeroSmsActivationRecord[]);
      if (records.length < 100) return all;
    }
  }

  async activationHistory(start: Date, end: Date): Promise<HeroSmsActivationRecord[]> {
    const all: HeroSmsActivationRecord[] = [];
    for (let offset = 0; ; offset += 100) {
      const value = await this.request('getHistory', {
        start: Math.floor(start.getTime() / 1000).toString(),
        end: Math.floor(end.getTime() / 1000).toString(),
        offset: offset.toString(), size: '100',
      });
      if (!Array.isArray(value)) throw new HeroSmsResponseError('response');
      const records = value.map((item) => activationRecord(item, false));
      if (records.some((record) => !record)) throw new HeroSmsResponseError('response');
      all.push(...records as HeroSmsActivationRecord[]);
      if (records.length < 100) return all;
    }
  }

  private async request(
    action: string,
    parameters: Record<string, string> = {},
    emptySuccessStatuses: number[] = [],
    acceptedResponse?: (value: unknown, status: number) => unknown | undefined,
  ): Promise<unknown> {
    const url = new URL(this.options.baseUrl);
    url.search = new URLSearchParams({ action, api_key: this.options.apiKey, ...parameters }).toString();

    let response: Response;
    let text: string;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.requestTimeoutMs ?? 15_000);
    try {
      response = await this.fetch(url, { signal: controller.signal });
      text = await response.text();
    } catch {
      throw new HeroSmsResponseError('uncertain');
    } finally {
      clearTimeout(timeout);
    }

    if (emptySuccessStatuses.includes(response.status) && response.ok) return undefined;
    const value = parseBody(text);
    const accepted = acceptedResponse?.(value, response.status);
    if (accepted !== undefined) return accepted;
    if (action === 'getNumberV2' && (response.status === 408 || response.status === 504)) {
      throw new HeroSmsResponseError('uncertain');
    }
    const returnedError = errorKind(value);
    if (returnedError) {
      throw new HeroSmsResponseError(returnedError);
    }
    if (!response.ok) {
      const kind: HeroSmsErrorKind = response.status === 401 ? 'authentication'
        : response.status === 402 ? 'balance'
          : response.status === 403 ? 'account'
            : response.status === 429 ? 'rate-limit'
              : response.status >= 500 ? 'provider'
                : 'request';
      throw new HeroSmsResponseError(kind);
    }
    return value;
  }
}
