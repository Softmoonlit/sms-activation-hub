import { Database, type DefaultCandidateLocation } from './database.js';
import type { HeroSms, HeroSmsCountry, HeroSmsQuote } from './herosms.js';

export interface CandidateLocation {
  id: number;
  name: string;
  price?: number;
  stock?: number;
}

export interface ConfiguredCandidateLocation {
  position: number;
  countryId: number;
  countryName?: string;
}

export interface CandidateLocationSettings {
  balance?: number;
  configuredCountryIds: number[];
  configuredLocations: ConfiguredCandidateLocation[];
  locations: CandidateLocation[];
  configurationComplete: boolean;
  heroSmsAvailable: boolean;
}

export class CandidateLocationValidationError extends Error {
  constructor() {
    super('请选择三至十个可查询的候选地区。');
  }
}

interface RemoteCandidateLocationSettings {
  balance: number;
  locations: CandidateLocation[];
}

function completeConfiguration(locations: DefaultCandidateLocation[]): boolean {
  return locations.length >= 3 && locations.length <= 10 && locations.every((location, index) => (
    location.position === index + 1 && Boolean(location.countryName?.trim())
  ));
}

function queryableLocation(location: CandidateLocation | undefined): location is CandidateLocation & { price: number; stock: number } {
  return Boolean(
    location
    && location.name.trim()
    && location.price !== undefined
    && Number.isFinite(location.price)
    && location.price >= 0
    && location.stock !== undefined
    && Number.isFinite(location.stock)
    && Number.isInteger(location.stock)
    && location.stock >= 0,
  );
}

export class DefaultCandidateLocations {
  constructor(
    private readonly database: Database,
    private readonly heroSms: HeroSms,
    private readonly openAiServiceCode: string,
  ) {}

  async settings(): Promise<CandidateLocationSettings> {
    const configuredLocations = await this.database.defaultCandidateLocations();
    const base = {
      configuredCountryIds: configuredLocations.map((location) => location.countryId),
      configuredLocations,
      configurationComplete: completeConfiguration(configuredLocations),
    };
    try {
      const remote = await this.remoteSettings();
      return { ...base, ...remote, heroSmsAvailable: true };
    } catch {
      return { ...base, heroSmsAvailable: false, locations: [] };
    }
  }

  async replace(countryIds: number[]): Promise<void> {
    if (countryIds.length < 3 || countryIds.length > 10) {
      throw new CandidateLocationValidationError();
    }
    const remote = await this.remoteSettings();
    const locationById = new Map(remote.locations.map((location) => [location.id, location]));
    const selected = countryIds.map((countryId) => locationById.get(countryId));
    const completeSelected = selected.map((location) => {
      if (!queryableLocation(location)) throw new CandidateLocationValidationError();
      return { countryId: location.id, countryName: location.name };
    });
    await this.database.replaceDefaultCandidateLocations(completeSelected);
  }

  private async remoteSettings(): Promise<RemoteCandidateLocationSettings> {
    const [balance, services, countries, quotes] = await Promise.all([
      this.heroSms.balance(),
      this.heroSms.services(),
      this.heroSms.countries(),
      this.heroSms.quotes(this.openAiServiceCode),
    ]);
    if (!services.some((service) => service.code === this.openAiServiceCode)) {
      throw new CandidateLocationValidationError();
    }

    const locations = this.locationsWithQuotes(countries, quotes);
    return { balance, locations };
  }

  private locationsWithQuotes(countries: HeroSmsCountry[], quotes: HeroSmsQuote[]): CandidateLocation[] {
    const quotesByCountry = new Map(quotes.map((quote) => [quote.countryId, quote]));
    return countries
      .map((country) => {
        const quote = quotesByCountry.get(country.id);
        return quote ? { ...country, price: quote.price, stock: quote.stock } : country;
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN') || a.id - b.id);
  }
}
