import { validateRunParameters } from './runParameters';

describe('validateRunParameters', () => {
  const parameters = [
    { name: 'service', type: 'string' as const, required: true },
    { name: 'limit', type: 'number' as const, required: false },
    { name: 'dry', type: 'bool' as const, required: true },
  ];

  test('reports required and typed values', () => {
    expect(validateRunParameters(parameters, { service: '', limit: 'not-a-number', dry: 'yes' })).toEqual({
      service: '此参数为必填项。',
      limit: '请输入有效数字。',
      dry: '请输入 true 或 false。',
    });
  });

  test('accepts valid values and empty optional values', () => {
    expect(validateRunParameters(parameters, { service: 'checkout', limit: '', dry: 'false' })).toEqual({});
  });
});
