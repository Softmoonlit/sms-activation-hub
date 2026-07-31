import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { HeroSmsHttpAdapter, HeroSmsResponseError } from '../src/herosms.js';

type HeroSmsOpenApi = { components: { examples: Record<string, { value: unknown }> } };
type RequestedUrl = URL;

const openApi = JSON.parse(readFileSync(new URL('../api___cn.json', import.meta.url), 'utf8')) as HeroSmsOpenApi;

function example<Value>(name: string): Value {
  return openApi.components.examples[name]?.value as Value;
}

function response(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

test('HeroSMS adapter 查询余额、服务、地区和 OpenAI 报价', async () => {
  const requests: RequestedUrl[] = [];
  const adapter = new HeroSmsHttpAdapter({
    apiKey: 'test-api-key',
    baseUrl: 'https://hero-sms.test/stubs/handler_api.php',
    fetch: async (input) => {
      const url = new URL(input.toString());
      requests.push(url);
      switch (url.searchParams.get('action')) {
        case 'getBalance':
          return response(example<string>('successfulBalanceExample'));
        case 'getServicesList':
          return response(JSON.stringify(example('successGetServicesListExample')));
        case 'getCountries':
          return response(JSON.stringify(example('successGetCountriesExample')));
        case 'getPrices':
          return response(JSON.stringify([{ 2: { cost: 0.08, count: 25370 } }]));
        default:
          throw new Error(`未预期操作 ${url.searchParams.get('action')}`);
      }
    },
  });

  assert.equal(await adapter.balance(), 100.5);
  assert.deepEqual(await adapter.services(), [{ code: 'aoo', name: 'Pegasus Airlines' }]);
  assert.deepEqual(await adapter.countries(), [{ id: 2, name: '哈萨克斯坦' }]);
  assert.deepEqual(await adapter.quotes('aoo'), [{ countryId: 2, price: 0.08, stock: 25370 }]);
  assert.deepEqual(requests.map((url) => url.searchParams.get('action')), ['getBalance', 'getServicesList', 'getCountries', 'getPrices']);
  assert.ok(requests.every((url) => url.searchParams.get('api_key') === 'test-api-key'));
  assert.equal(requests[3]?.searchParams.get('service'), 'aoo');
});

test('HeroSMS adapter 兼容 getNumber 成功文本与 getNumberV2 JSON 响应', async () => {
  const responses = [
    response(example<string>('successfulNumberExample')),
    response(JSON.stringify(example('successfulNumberv2Example'))),
  ];
  const adapter = new HeroSmsHttpAdapter({
    apiKey: 'test-api-key',
    baseUrl: 'https://hero-sms.test/stubs/handler_api.php',
    fetch: async (input) => {
      const url = new URL(input.toString());
      assert.equal(url.searchParams.get('action'), 'getNumberV2');
      assert.equal(url.searchParams.get('service'), 'openai');
      assert.equal(url.searchParams.get('country'), '6');
      return responses.shift()!;
    },
  });

  assert.deepEqual(await adapter.getNumber('openai', 6), {
    activationId: '123456789', phoneNumber: '7*********0',
  });
  assert.deepEqual(await adapter.getNumber('openai', 6), {
    activationId: '635468024', phoneNumber: '79584******', activationCost: 12.5,
    currency: '840', activationTime: new Date('2026-02-18T16:11:33+00:00'),
    activationEndTime: new Date('2026-02-18T18:11:23+00:00'),
  });
});

test('HeroSMS adapter 兼容线上地区对象和按服务嵌套的报价对象', async () => {
  const adapter = new HeroSmsHttpAdapter({
    apiKey: 'test-api-key',
    baseUrl: 'https://hero-sms.test/stubs/handler_api.php',
    fetch: async (input) => {
      const action = new URL(input.toString()).searchParams.get('action');
      if (action === 'getCountries') {
        return response(JSON.stringify({
          1: { id: 1, rus: 'Украина', eng: 'Ukraine', chn: '乌克兰', visible: 1 },
          2: { id: 2, rus: 'Казахстан', eng: 'Kazakhstan', chn: '哈萨克斯坦', visible: 1 },
        }));
      }
      if (action === 'getPrices') {
        return response(JSON.stringify({
          1: { dr: { cost: 0.11, count: 1976, physicalCount: 648 } },
          2: { dr: { cost: 0.055, count: 4641, physicalCount: 0 } },
        }));
      }
      throw new Error(`未预期操作 ${action}`);
    },
  });

  assert.deepEqual(await adapter.countries(), [
    { id: 1, name: '乌克兰' },
    { id: 2, name: '哈萨克斯坦' },
  ]);
  assert.deepEqual(await adapter.quotes('dr'), [
    { countryId: 1, price: 0.11, stock: 1976 },
    { countryId: 2, price: 0.055, stock: 4641 },
  ]);
});

test('HeroSMS adapter 将兼容文本和 JSON 错误归类且不包含请求 URL', async () => {
  const textErrorAdapter = new HeroSmsHttpAdapter({
    apiKey: 'secret-key',
    baseUrl: 'https://hero-sms.test/stubs/handler_api.php',
    fetch: async () => response(example<string>('incorrectKeyExample')),
  });
  const jsonErrorAdapter = new HeroSmsHttpAdapter({
    apiKey: 'secret-key',
    baseUrl: 'https://hero-sms.test/stubs/handler_api.php',
    fetch: async () => response(JSON.stringify(example('incorrectServiceExample'))),
  });

  await assert.rejects(textErrorAdapter.balance(), (error: unknown) => {
    assert.ok(error instanceof HeroSmsResponseError);
    assert.equal(error.kind, 'authentication');
    assert.doesNotMatch(error.message, /secret-key|hero-sms\.test/);
    return true;
  });
  await assert.rejects(jsonErrorAdapter.quotes('openai'), (error: unknown) => {
    assert.ok(error instanceof HeroSmsResponseError);
    assert.equal(error.kind, 'request');
    assert.doesNotMatch(error.message, /secret-key|hero-sms\.test/);
    return true;
  });

  const noNumbersAdapter = new HeroSmsHttpAdapter({
    apiKey: 'secret-key', baseUrl: 'https://hero-sms.test/stubs/handler_api.php',
    fetch: async () => response(example<string>('numbersNotFoundExample')),
  });
  await assert.rejects(noNumbersAdapter.getNumber('openai', 1), (error: unknown) => {
    assert.ok(error instanceof HeroSmsResponseError);
    assert.equal(error.kind, 'no-numbers');
    return true;
  });
});

test('HeroSMS adapter 拒绝格式错误的成功响应', async () => {
  const adapter = new HeroSmsHttpAdapter({
    apiKey: 'test-api-key',
    baseUrl: 'https://hero-sms.test/stubs/handler_api.php',
    fetch: async () => response('ACCESS_BALANCE:not-a-number'),
  });

  await assert.rejects(adapter.balance(), HeroSmsResponseError);
});
