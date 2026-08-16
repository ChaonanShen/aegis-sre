import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AppServicesProvider } from '../../app/AppServices';
import { AppShellProvider } from '../../app/AppShellContext';
import { FolderGateway } from '../../app/ports/FolderGateway';
import { FolderPermission } from '../../app/model';
import RealKnowledgePage from './RealKnowledgePage';
import { KnowledgeBaseRecord, KnowledgeDocumentRecord } from './managementModel';
import { KnowledgeManagementGateway } from './ports/KnowledgeManagementGateway';

const kb: KnowledgeBaseRecord = {
  id: 'kbs_ops',
  name: 'Operations',
  folder_uid: 'ops',
  created_at: '2026-08-14T00:00:00Z',
  updated_at: '2026-08-14T00:00:00Z',
};
const document: KnowledgeDocumentRecord = {
  id: 'doc_guide',
  knowledge_base_id: kb.id,
  name: 'restart.md',
  media_type: 'text/markdown',
  service: 'api',
  tags: ['prod'],
  status: 'ready',
  size: 1024,
};

describe('real Knowledge management page', () => {
  beforeEach(() => window.sessionStorage.clear());

  test('loads folder-scoped knowledge bases and documents', async () => {
    const gateway = fakeGateway();
    renderPage(gateway);

    expect(await screen.findByRole('heading', { name: 'Operations' })).toBeInTheDocument();
    expect(await screen.findByText('restart.md')).toBeInTheDocument();
    expect(gateway.listKnowledgeBases).toHaveBeenCalledWith('ops', expect.any(AbortSignal));
    expect(gateway.listDocuments).toHaveBeenCalledWith('ops', kb.id, expect.any(AbortSignal));
  });

  test('uploads the real file with metadata and a fresh idempotency key', async () => {
    const gateway = fakeGateway();
    renderPage(gateway);
    await screen.findByText('restart.md');
    const file = new File(['# runbook'], 'runbook.md', { type: 'text/markdown' });
    fireEvent.change(screen.getByLabelText('选择文档'), { target: { files: [file] } });
    fireEvent.change(screen.getByLabelText('所属服务'), { target: { value: 'checkout' } });
    fireEvent.change(screen.getByLabelText('文档标签'), { target: { value: 'prod, guide' } });
    fireEvent.submit(screen.getByRole('button', { name: /上传/ }).closest('form')!);

    await waitFor(() => expect(gateway.uploadDocument).toHaveBeenCalled());
    expect(gateway.uploadDocument).toHaveBeenCalledWith(
      'ops',
      kb.id,
      expect.objectContaining({
        file,
        service: 'checkout',
        tags: ['prod', 'guide'],
        idempotencyKey: expect.stringMatching(/^upload-/),
      })
    );
  });

  test('shows stable citations returned by semantic search', async () => {
    const gateway = fakeGateway();
    renderPage(gateway);
    await screen.findByRole('heading', { name: 'Operations' });
    fireEvent.click(screen.getByRole('button', { name: '检索测试' }));
    fireEvent.change(screen.getByLabelText('检索问题'), { target: { value: '如何重启' } });
    fireEvent.click(screen.getByRole('button', { name: '检索' }));

    expect(await screen.findByText('先检查健康状态。')).toBeInTheDocument();
    expect(screen.getByText(/restart.md · paragraph-4/)).toBeInTheDocument();
    expect(gateway.search).toHaveBeenCalledWith(
      'ops',
      expect.objectContaining({ knowledgeBaseIds: [kb.id], query: '如何重启' }),
      expect.any(AbortSignal)
    );
  });

  test('loads and renders document passages without Provider chunk IDs', async () => {
    const gateway = fakeGateway();
    renderPage(gateway);
    await screen.findByText('restart.md');
    const list = await screen.findByRole('region', { name: '文档列表' });
    fireEvent.click(within(list).getByRole('button', { name: '段落' }));
    expect(await screen.findByText('检查实例健康并逐个重启。')).toBeInTheDocument();
    expect(screen.getByText('paragraph-4')).toBeInTheDocument();
  });

  test('updates document service and tags through the public metadata contract', async () => {
    const gateway = fakeGateway();
    renderPage(gateway);
    await screen.findByText('restart.md');
    fireEvent.click(screen.getByText('元数据'));
    fireEvent.change(screen.getByLabelText('restart.md 服务'), { target: { value: 'checkout' } });
    fireEvent.change(screen.getByLabelText('restart.md 标签'), { target: { value: 'prod, guide' } });
    fireEvent.submit(screen.getByLabelText('restart.md 服务').closest('form')!);
    await waitFor(() =>
      expect(gateway.updateDocument).toHaveBeenCalledWith('ops', kb.id, document.id, {
        service: 'checkout',
        tags: ['prod', 'guide'],
      })
    );
  });

  test('offers retry only for failed documents and never shows stop or manual index actions', async () => {
    const gateway = fakeGateway();
    gateway.listDocuments = jest.fn(async () => [
      { ...document, status: 'failed' as const, failure_reason: '文档解析失败' },
    ]);
    renderPage(gateway);

    expect(await screen.findByText('文档解析失败')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重试索引' }));
    await waitFor(() =>
      expect(gateway.retryDocumentIndex).toHaveBeenCalledWith('ops', kb.id, document.id)
    );
    expect(screen.queryByRole('button', { name: '停止' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '索引' })).not.toBeInTheDocument();
  });

  test('shows root deletion only to Folder admins while editors retain ordinary writes', async () => {
    const editor = renderPage(fakeGateway(), 'Edit');
    await screen.findByRole('heading', { name: 'Operations' });
    expect(screen.getByRole('button', { name: '保存名称' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /删除$/ })).not.toBeInTheDocument();
    editor.unmount();

    renderPage(fakeGateway(), 'Admin');
    await screen.findByRole('heading', { name: 'Operations' });
    expect(screen.getByRole('button', { name: /删除$/ })).toBeInTheDocument();
  });

});

function renderPage(gateway: KnowledgeManagementGateway, permission: FolderPermission = 'Edit') {
  const folderGateway: FolderGateway = {
    listFolders: async () => [{ uid: 'ops', title: 'Operations', permission, serviceCount: 0 }],
  };
  return render(
    <AppServicesProvider runtimeMode="real" services={{ folderGateway, knowledgeManagementGateway: gateway }}>
      <AppShellProvider>
        <RealKnowledgePage gateway={gateway} />
      </AppShellProvider>
    </AppServicesProvider>
  );
}

function fakeGateway(): KnowledgeManagementGateway {
  return {
    getAvailability: jest.fn(async () => ({ status: 'available' as const })),
    listKnowledgeBases: jest.fn(async () => [kb]),
    createKnowledgeBase: jest.fn(async () => kb),
    updateKnowledgeBase: jest.fn(async () => kb),
    deleteKnowledgeBase: jest.fn(async () => undefined),
    listDocuments: jest.fn(async () => [document]),
    getDocument: jest.fn(async () => document),
    uploadDocument: jest.fn(async () => document),
    updateDocument: jest.fn(async () => document),
    deleteDocument: jest.fn(async () => undefined),
    retryDocumentIndex: jest.fn(async () => document),
    listPassages: jest.fn(async () => [
      {
        ordinal: 1,
        text: '检查实例健康并逐个重启。',
        location: 'paragraph-4',
      },
    ]),
    downloadDocument: jest.fn(async () => new Blob(['# restart'])),
    search: jest.fn(async () => [
      {
        text: '先检查健康状态。',
        citation: {
          document_id: document.id,
          knowledge_base_id: kb.id,
          source_name: document.name,
          ordinal: 1,
          location: 'paragraph-4',
        },
      },
    ]),
  };
}
