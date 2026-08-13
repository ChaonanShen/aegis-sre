import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { fixtureFolders } from '../../../app/fixtures/folderFixtures';
import { createFixtureSkillGateway } from '../adapters/fixtureSkillGateway';
import { skillFixtureData } from '../fixtures/skillFixtures';
import { SkillGateway } from '../ports/SkillGateway';
import { SkillEditor } from './SkillEditor';

describe('SkillEditor', () => {
  test('does not repeat a committed save when list refresh fails', async () => {
    const values = new Map<string, string>();
    const base = createFixtureSkillGateway({
      latencyMs: 0,
      storage: {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
      },
    });
    const updateSkill = jest.fn((...args: Parameters<SkillGateway['updateSkill']>) => base.updateSkill(...args));
    const gateway: SkillGateway = { ...base, updateSkill };

    render(
      <MemoryRouter>
        <SkillEditor
          folders={fixtureFolders}
          gateway={gateway}
          onSaved={async () => {
            throw new Error('refresh unavailable');
          }}
          skill={skillFixtureData.skills[0]}
        />
      </MemoryRouter>
    );

    fireEvent.change(screen.getByRole('textbox', { name: 'Skill change note' }), {
      target: { value: '测试已保存状态' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    const saved = await screen.findByRole('button', { name: '已保存' });
    expect(saved).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('已保存，但列表刷新失败');

    fireEvent.click(saved);
    expect(updateSkill).toHaveBeenCalledTimes(1);
  });
});
