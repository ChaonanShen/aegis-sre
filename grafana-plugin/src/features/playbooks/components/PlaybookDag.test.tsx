import React from 'react';
import { render } from '@testing-library/react';
import { PlaybookStep } from '../model';
import { PlaybookDag } from './PlaybookDag';

describe('PlaybookDag', () => {
  test('renders malformed cyclic dependencies without overflowing the stack', () => {
    const steps: PlaybookStep[] = [step('first', ['second']), step('second', ['first'])];

    const { getByRole } = render(<PlaybookDag steps={steps} />);

    expect(getByRole('img', { name: 'Playbook DAG' }).querySelectorAll('[data-step-id]')).toHaveLength(2);
  });
});

function step(id: string, dependsOn: string[]): PlaybookStep {
  return {
    id,
    type: 'query',
    label: id,
    dependsOn,
    config: {},
    expect: { expression: '', onFail: 'fail' },
    sideEffect: false,
    dryRun: false,
  };
}
