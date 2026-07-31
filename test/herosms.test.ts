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
});

test('HeroSMS adapter 拒绝格式错误的成功响应', async () => {
  const adapter = new HeroSmsHttpAdapter({
    apiKey: 'test-api-key',
    baseUrl: 'https://hero-sms.test/stubs/handler_api.php',
    fetch: async () => response('ACCESS_BALANCE:not-a-number'),
  });

  await assert.rejects(adapter.balance(), HeroSmsResponseError);
});
