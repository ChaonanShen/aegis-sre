import { canEditVisibleResource } from './resourcePermissions';

describe('canEditVisibleResource', () => {
  test('allows visible private resources and writable shared folders', () => {
    expect(canEditVisibleResource('private')).toBe(true);
    expect(canEditVisibleResource('shared', 'View')).toBe(false);
    expect(canEditVisibleResource('shared', 'Edit')).toBe(true);
    expect(canEditVisibleResource('shared', 'Admin')).toBe(true);
  });
});
