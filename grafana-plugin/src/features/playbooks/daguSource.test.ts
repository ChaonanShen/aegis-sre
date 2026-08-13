import { projectDaguSource } from './daguSource';

describe('Dagu source projection', () => {
  test('projects graph dependencies, mcp.call, human.task and schema params without rewriting source', () => {
    const source = `name: diagnose
description: Diagnose service
params:
  type: object
  properties:
    service: {type: string, default: api}
  required: [service]
steps:
  - id: metrics
    action: mcp.call
    with: {server: grafana-read, tool: query_prometheus}
  - id: review
    depends: [metrics]
    action: human.task
    with: {prompt: Review result}
`;
    const projected = projectDaguSource(source);
    expect(projected.name).toBe('diagnose');
    expect(projected.parameters).toEqual([{ name: 'service', type: 'string', defaultValue: 'api', required: true }]);
    expect(projected.steps).toEqual([
      expect.objectContaining({ id: 'metrics', type: 'mcp_call', dependsOn: [] }),
      expect.objectContaining({ id: 'review', type: 'branch', dependsOn: ['metrics'], sideEffect: true }),
    ]);
  });

  test('rejects malformed roots and missing steps', () => {
    expect(() => projectDaguSource('- invalid')).toThrow(/顶层/);
    expect(() => projectDaguSource('name: missing-steps')).toThrow(/steps/);
  });
});
