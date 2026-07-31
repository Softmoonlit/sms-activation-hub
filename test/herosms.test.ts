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

test('HeroSMS adapter 将号码获取的明确账户错误分类为不可重试失败', async () => {
  const cases = [
    ['NO_BALANCE', 'balance'],
    ['BAD_KEY', 'authentication'],
    [JSON.stringify({ title: 'ACCOUNT_INACTIVE', details: 'Activate your account' }), 'account'],
    [JSON.stringify({ title: 'CHANNELS_LIMIT', details: 'Too many channels' }), 'account'],
    [JSON.stringify({ title: 'WRONG_COUNTRY', details: 'Wrong country' }), 'request'],
    [JSON.stringify({ title: 'RATE_LIMIT', details: 'Slow down' }), 'rate-limit'],
    [JSON.stringify({ title: 'SERVER_ERROR', details: 'Try later' }), 'provider'],
  ] as const;

  for (const [body, kind] of cases) {
    const adapter = new HeroSmsHttpAdapter({
      apiKey: 'secret-key', baseUrl: 'https://hero-sms.test/stubs/handler_api.php',
      fetch: async () => response(body),
    });
    await assert.rejects(adapter.getNumber('openai', 1), (error: unknown) => {
      assert.ok(error instanceof HeroSmsResponseError);
      assert.equal(error.kind, kind);
      return true;
    });
  }
});

test('HeroSMS adapter 将断网与不可解析的号码响应分类为结果不确定', async () => {
  const disconnected = new HeroSmsHttpAdapter({
    apiKey: 'secret-key', baseUrl: 'https://hero-sms.test/stubs/handler_api.php',
    fetch: async () => { throw new TypeError('connection reset'); },
  });
  const malformed = new HeroSmsHttpAdapter({
    apiKey: 'secret-key', baseUrl: 'https://hero-sms.test/stubs/handler_api.php',
    fetch: async () => response('<html>upstream timeout</html>'),
  });
  const timedOut = new HeroSmsHttpAdapter({
    apiKey: 'secret-key', baseUrl: 'https://hero-sms.test/stubs/handler_api.php', requestTimeoutMs: 1,
    fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }),
  });
  const gatewayTimeout = new HeroSmsHttpAdapter({
    apiKey: 'secret-key', baseUrl: 'https://hero-sms.test/stubs/handler_api.php',
    fetch: async () => response(JSON.stringify({ title: 'SERVER_ERROR' }), 504),
  });

  for (const adapter of [disconnected, malformed, timedOut, gatewayTimeout]) {
    await assert.rejects(adapter.getNumber('openai', 1), (error: unknown) => {
      assert.ok(error instanceof HeroSmsResponseError);
      assert.equal(error.kind, 'uncertain');
      return true;
    });
  }
});

test('HeroSMS adapter 读取活动激活与历史供号码获取对账', async () => {
  const requests: URL[] = [];
  const adapter = new HeroSmsHttpAdapter({
    apiKey: 'test-api-key', baseUrl: 'https://hero-sms.test/stubs/handler_api.php',
    fetch: async (input) => {
      const url = new URL(input.toString());
      requests.push(url);
      if (url.searchParams.get('action') === 'getActiveActivations') {
        return response(JSON.stringify(example('activationsSuccessfulExample')));
      }
      return response(JSON.stringify(example('successfulActivationsHistoryExample')));
    },
  });

  assert.deepEqual(await adapter.activeActivations(), [{
    activationId: '635468021', phoneNumber: '79********1', activationCost: 12.5,
    currency: '840', serviceCode: 'vk', countryId: 2,
    activationTime: new Date('2022-06-01T16:59:16Z'), status: '4',
  }]);
  assert.deepEqual(await adapter.activationHistory(new Date('2026-02-18T15:00:00Z'), new Date('2026-02-18T17:00:00Z')), [{
    activationId: '635468024', phoneNumber: '7*********0', activationCost: 0,
    currency: '840', activationTime: undefined, status: '4',
  }]);
  assert.equal(requests[1]?.searchParams.get('start'), '1771426800');
  assert.equal(requests[1]?.searchParams.get('end'), '1771434000');
});

test('HeroSMS adapter 读取结构化短信状态并完成供应商激活', async () => {
  const requests: URL[] = [];
  const adapter = new HeroSmsHttpAdapter({
    apiKey: 'test-api-key', baseUrl: 'https://hero-sms.test/stubs/handler_api.php',
    fetch: async (input) => {
      const url = new URL(input.toString()); requests.push(url);
      if (url.searchParams.get('action') === 'getStatusV2') {
        return response(JSON.stringify({ verificationType: 2, sms: { dateTime: '2026-08-01 00:03:00', code: '482913', text: 'Your code is 482913' } }));
      }
      return new Response(null, { status: 204 });
    },
  });

  assert.deepEqual(await adapter.activationStatus('activation-42'), {
    delivered: true, receivedAt: new Date('2026-08-01T00:03:00.000Z'), code: '482913', text: 'Your code is 482913',
  });
  await adapter.finishActivation('activation-42');
  assert.deepEqual(requests.map((url) => [url.searchParams.get('action'), url.searchParams.get('id')]), [
    ['getStatusV2', 'activation-42'], ['finishActivation', 'activation-42'],
  ]);
});

test('HeroSMS adapter 解析已结束状态并分类轮询与完成错误响应', async () => {
  const ended = new HeroSmsHttpAdapter({
    apiKey: 'test-api-key', baseUrl: 'https://hero-sms.test/stubs/handler_api.php',
    fetch: async () => response('STATUS_CANCEL'),
  });
  assert.deepEqual(await ended.activationStatus('activation-42'), { delivered: false, providerStatus: 'cancelled' });

  const malformedStatus = new HeroSmsHttpAdapter({
    apiKey: 'test-api-key', baseUrl: 'https://hero-sms.test/stubs/handler_api.php',
    fetch: async () => response(JSON.stringify({ sms: { code: '482913' } })),
  });
  await assert.rejects(malformedStatus.activationStatus('activation-42'), (error: unknown) => {
    assert.ok(error instanceof HeroSmsResponseError);
    assert.equal(error.kind, 'response');
    return true;
  });

  const uncertainFinish = new HeroSmsHttpAdapter({
    apiKey: 'test-api-key', baseUrl: 'https://hero-sms.test/stubs/handler_api.php',
    fetch: async () => { throw new TypeError('connection reset'); },
  });
  await assert.rejects(uncertainFinish.finishActivation('activation-42'), (error: unknown) => {
    assert.ok(error instanceof HeroSmsResponseError);
    assert.equal(error.kind, 'uncertain');
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
