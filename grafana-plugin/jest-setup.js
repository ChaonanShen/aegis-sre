// Jest setup provided by Grafana scaffolding
import './.config/jest-setup';

Object.defineProperty(globalThis.crypto, 'randomUUID', {
  configurable: true,
  value: jest.fn(() => '123e4567-e89b-42d3-a456-426614174000'),
});
