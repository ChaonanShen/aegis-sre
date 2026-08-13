import { newClientTurnId } from './clientTurnId';

describe('newClientTurnId', () => {
  test('安全上下文优先使用浏览器原生 randomUUID', () => {
    const randomUUID = jest.fn(
      () => '123e4567-e89b-42d3-a456-426614174000' as `${string}-${string}-${string}-${string}-${string}`
    );
    const getRandomValues = jest.fn();

    expect(newClientTurnId({ randomUUID, getRandomValues })).toBe('123e4567-e89b-42d3-a456-426614174000');
    expect(randomUUID).toHaveBeenCalledTimes(1);
    expect(getRandomValues).not.toHaveBeenCalled();
  });

  test('HTTP 非安全上下文使用 getRandomValues 生成 UUID v4', () => {
    const getRandomValuesCall = jest.fn();
    const cryptoAPI = {
      getRandomValues<T extends ArrayBufferView>(array: T): T {
        getRandomValuesCall();
        const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
        bytes.set(Array.from({ length: 16 }, (_, index) => index));
        return array;
      },
    };

    expect(newClientTurnId(cryptoAPI)).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f');
    expect(getRandomValuesCall).toHaveBeenCalledTimes(1);
  });
});
