import { Database } from './database.js';
import type { HeroSms } from './herosms.js';

export interface CandidateLocation {
  id: number;
  name: string;
  price?: number;
  stock?: number;
}

export interface CandidateLocationSettings {
  balance: number;
  configuredCountryIds: number[];
  locations: CandidateLocation[];
}

export class CandidateLocationValidationError extends Error {
  constructor() {
    super('请选择三个可查询的候选地区。');
  }
}

export class DefaultCandidateLocations {
  constructor(
    private readonly database: Database,
    private readonly heroSms: HeroSms,
    private readonly openAiServiceCode: string,
  ) {}

  async settings(): Promise<CandidateLocationSettings> {
    const [balance, services, countries, quotes, configuredCountryIds] = await Promise.all([
      this.heroSms.balance(),
      this.heroSms.services(),
      this.heroSms.countries(),
      this.heroSms.quotes(this.openAiServiceCode),
      this.database.defaultCandidateCountryIds(),
    ]);
    if (!services.some((service) => service.code === this.openAiServiceCode)) {
      throw new CandidateLocationValidationError();
    }

    const quotesByCountry = new Map(quotes.map((quote) => [quote.countryId, quote]));
    const locations = countries
      .map((country) => {
        const quote = quotesByCountry.get(country.id);
        return quote ? { ...country, price: quote.price, stock: quote.stock } : country;
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN') || a.id - b.id);
    return {
      balance,
      configuredCountryIds,
      locations,
    };
  }

  async replace(countryIds: number[]): Promise<void> {
    if (countryIds.length !== 3) {
      throw new CandidateLocationValidationError();
    }
    const settings = await this.settings();
    const queryableCountryIds = new Set(settings.locations.filter((location) => location.price !== undefined && location.stock !== undefined).map((location) => location.id));
    if (countryIds.some((countryId) => !queryableCountryIds.has(countryId))) {
      throw new CandidateLocationValidationError();
    }
    await this.database.replaceDefaultCandidateCountryIds(countryIds);
  }
}
