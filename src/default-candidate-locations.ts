import { Database, type DefaultCandidateLocation } from './database.js';
import { MAX_CANDIDATE_POSITION_COUNT, MIN_CANDIDATE_POSITION_COUNT } from './candidate-position.js';
import { budgetStockAtPrice, type HeroSms, type HeroSmsCountry, type HeroSmsOffer } from './herosms.js';

export interface CandidateLocation {
  id: number;
  name: string;
  defaultPrice?: number;
  budgetStock?: number;
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
  maxPricePerNumber: number;
}

export class CandidateLocationValidationError extends Error {
  constructor() {
    super('请选择三至十个可查询的候选地区。');
  }
}

export class MaxPricePerNumberValidationError extends Error {
  constructor() {
    super('每号最高价必须是大于等于 0 的数字。');
  }
}

interface RemoteCandidateLocationSettings {
  balance: number;
  locations: CandidateLocation[];
}

function completeConfiguration(locations: DefaultCandidateLocation[]): boolean {
  return locations.length >= MIN_CANDIDATE_POSITION_COUNT
    && locations.length <= MAX_CANDIDATE_POSITION_COUNT
    && locations.every((location, index) => (
    location.position === index + 1 && Boolean(location.countryName?.trim())
  ));
}

function queryableLocation(location: CandidateLocation | undefined): location is CandidateLocation & { defaultPrice: number; budgetStock: number } {
  return Boolean(
    location
    && location.name.trim()
    && location.defaultPrice !== undefined
    && Number.isFinite(location.defaultPrice)
    && location.defaultPrice >= 0
    && location.budgetStock !== undefined
    && Number.isFinite(location.budgetStock)
    && Number.isInteger(location.budgetStock)
    && location.budgetStock >= 0,
  );
}

export class DefaultCandidateLocations {
  constructor(
    private readonly database: Database,
    private readonly heroSms: HeroSms,
    private readonly openAiServiceCode: string,
  ) {}

  async settings(): Promise<CandidateLocationSettings> {
    const [configuredLocations, maxPricePerNumber] = await Promise.all([
      this.database.defaultCandidateLocations(),
      this.database.maxPricePerNumber(),
    ]);
    const base = {
      configuredCountryIds: configuredLocations.map((location) => location.countryId),
      configuredLocations,
      configurationComplete: completeConfiguration(configuredLocations),
      maxPricePerNumber,
    };
    try {
      const remote = await this.remoteSettings(maxPricePerNumber);
      return { ...base, ...remote, heroSmsAvailable: true };
    } catch {
      return { ...base, heroSmsAvailable: false, locations: [] };
    }
  }

  async replace(countryIds: number[], maxPricePerNumber: number): Promise<void> {
    if (!Number.isFinite(maxPricePerNumber) || maxPricePerNumber < 0) {
      throw new MaxPricePerNumberValidationError();
    }
    if (countryIds.length < MIN_CANDIDATE_POSITION_COUNT || countryIds.length > MAX_CANDIDATE_POSITION_COUNT) {
      throw new CandidateLocationValidationError();
    }
    let completeSelected: { countryId: number; countryName: string }[];
    try {
      completeSelected = await this.completeSelectedLocations(countryIds, maxPricePerNumber);
    } catch (error) {
      // 供应商报价接口不可用时仍允许保存每号最高价：提交的候选地区必须与库中
      // 已保存配置逐位一致，地区名称沿用库中值，不引入未经验证的新地区。
      const existing = await this.database.completeDefaultCandidateLocations();
      if (!existing || existing.length !== countryIds.length
        || existing.some((location, index) => location.countryId !== countryIds[index])) {
        throw error;
      }
      completeSelected = existing.map((location) => ({ countryId: location.countryId, countryName: location.countryName }));
    }
    await this.database.saveCandidateSettings(completeSelected, maxPricePerNumber);
  }

  private async completeSelectedLocations(countryIds: number[], maxPricePerNumber: number): Promise<{ countryId: number; countryName: string }[]> {
    const remote = await this.remoteSettings(maxPricePerNumber);
    const locationById = new Map(remote.locations.map((location) => [location.id, location]));
    const selected = countryIds.map((countryId) => locationById.get(countryId));
    return selected.map((location) => {
      if (!queryableLocation(location)) throw new CandidateLocationValidationError();
      return { countryId: location.id, countryName: location.name };
    });
  }

  private async remoteSettings(maxPricePerNumber: number): Promise<RemoteCandidateLocationSettings> {
    const [balance, services, countries, offers] = await Promise.all([
      this.heroSms.balance(),
      this.heroSms.services(),
      this.heroSms.countries(),
      this.heroSms.offers(),
    ]);
    if (!services.some((service) => service.code === this.openAiServiceCode)) {
      throw new CandidateLocationValidationError();
    }

    const locations = this.locationsWithOffers(countries, offers, maxPricePerNumber);
    return { balance, locations };
  }

  private locationsWithOffers(
    countries: HeroSmsCountry[],
    offers: HeroSmsOffer[],
    maxPricePerNumber: number,
  ): CandidateLocation[] {
    const offersByCountry = new Map(
      offers
        .filter((offer) => offer.serviceCode === this.openAiServiceCode)
        .map((offer) => [offer.countryId, offer]),
    );
    return countries
      .map((country) => {
        const offer = offersByCountry.get(country.id);
        return offer
          ? { ...country, defaultPrice: offer.defaultPrice, budgetStock: budgetStockAtPrice(offer.map, maxPricePerNumber) }
          : country;
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN') || a.id - b.id);
  }
}
