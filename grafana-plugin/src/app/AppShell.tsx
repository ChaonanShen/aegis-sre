import React, { useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import type { GrafanaTheme2 } from '@grafana/data';
import { useTheme2 } from '@grafana/ui';
import {
  Bell,
  Check,
  CheckSquare,
  ChevronDown,
  Folder as FolderIcon,
  Library,
  Menu,
  MessageSquare,
  RefreshCw,
  ScrollText,
  Search,
  Settings,
  Wand2,
  Workflow,
  X,
} from 'lucide-react';
import { PLUGIN_BASE_URL, ROUTES } from '../constants';
import { prefixRoute } from '../utils/utils.routing';
import { useAppServices } from './AppServices';
import { useAppShell } from './AppShellContext';
import { PRODUCT_BRAND } from './brand';
import { Folder, FolderPermission } from './model';

const navItems = [
  { route: ROUTES.Workbench, label: '对话', icon: MessageSquare },
  { route: ROUTES.Knowledge, label: '知识库', icon: Library },
  { route: ROUTES.Playbooks, label: 'Playbooks', icon: Workflow },
  { route: ROUTES.Skills, label: 'Skills', icon: Wand2 },
  { route: ROUTES.Approvals, label: '审批', icon: CheckSquare },
  { route: ROUTES.Alerts, label: '告警', icon: Bell },
  { route: ROUTES.Audit, label: '审计', icon: ScrollText },
];

export function AppShell({ children }: React.PropsWithChildren) {
  const location = useLocation();
  const theme = useTheme2();

  return (
    <div className="torchbearing-app" data-testid="torchbearing-app" style={themeVariables(theme)}>
      <nav aria-label={`${PRODUCT_BRAND.name} 功能导航`} className="sidenav">
        <div className="sidenav-logo" title={PRODUCT_BRAND.name}>
          TB
        </div>
        {navItems.map(({ route, label, icon: Icon }) => (
          <NavLink
            aria-label={label}
            className={({ isActive }) => `sidenav-icon${isActive ? ' active' : ''}`}
            key={route}
            title={label}
            to={prefixRoute(route)}
          >
            <Icon aria-hidden size={18} />
          </NavLink>
        ))}
        <span className="sidenav-spacer" />
        <a
          aria-label="设置"
          className="sidenav-icon"
          href={`/plugins/${PLUGIN_BASE_URL.split('/').at(-1)}`}
          title="设置"
        >
          <Settings aria-hidden size={18} />
        </a>
      </nav>

      <section className="app-main">
        <TopBar />
        <div className="app-content" key={location.pathname}>
          {children}
        </div>
      </section>
    </div>
  );
}

function TopBar() {
  const location = useLocation();
  const { runtimeMode } = useAppServices();
  const { activeFolder, folders, refreshFolders, setActiveFolder } = useAppShell();
  const folderList = folders.status === 'success' ? folders.data : [];

  return (
    <header className="topbar">
      <MobileNav key={`${location.pathname}${location.search}`} />
      <div className="topbar-title">
        <span>{PRODUCT_BRAND.wordmark}</span>
        <strong>{PRODUCT_BRAND.tagline}</strong>
      </div>
      {runtimeMode === 'fixture' && (
          <span aria-label="演示数据模式" className="runtime-badge">
            演示数据
          </span>
      )}
      <FolderDropdown
        activeFolder={activeFolder}
        error={folders.status === 'error'}
        folders={folderList}
        loading={folders.status === 'loading'}
        onChange={setActiveFolder}
        onRefresh={refreshFolders}
      />
      <span className="topbar-spacer" />
    </header>
  );
}

/**
 * The desktop rail is intentionally icon-only. On narrow screens it is hidden,
 * so this drawer keeps every destination and the plugin settings link reachable.
 */
function MobileNav() {
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const close = React.useCallback(() => {
    setOpen(false);
    toggleRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }

      if (event.key !== 'Tab' || !panelRef.current) {
        return;
      }

      const focusable = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      );
      if (focusable.length === 0) {
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    const firstFocusable = panelRef.current?.querySelector<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    firstFocusable?.focus();

    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [close, open]);

  return (
    <div className="mobile-nav">
      <button
        aria-controls="mobile-navigation"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={open ? '关闭功能导航' : '打开功能导航'}
        className="mobile-nav-toggle"
        onClick={() => (open ? close() : setOpen(true))}
        ref={toggleRef}
        type="button"
      >
        {open ? <X aria-hidden size={19} /> : <Menu aria-hidden size={19} />}
      </button>

      {open && (
        <div className="mobile-nav-layer">
          <button aria-label="关闭导航面板" className="mobile-nav-backdrop" onClick={close} type="button" />
          <div
            aria-label={`${PRODUCT_BRAND.name} 功能导航`}
            aria-modal="true"
            className="mobile-nav-panel"
            id="mobile-navigation"
            ref={panelRef}
            role="dialog"
          >
            <div className="mobile-nav-header">
              <div className="sidenav-logo" title={PRODUCT_BRAND.name}>
                TB
              </div>
              <div className="mobile-nav-brand">
                <strong>{PRODUCT_BRAND.wordmark}</strong>
                <span>{PRODUCT_BRAND.tagline}</span>
              </div>
              <button aria-label="关闭面板" className="mobile-nav-close" onClick={close} type="button">
                <X aria-hidden size={17} />
              </button>
            </div>

            <nav aria-label={`${PRODUCT_BRAND.name} 移动功能导航`} className="mobile-nav-links">
              {navItems.map(({ route, label, icon: Icon }) => (
                <NavLink
                  className={({ isActive }) => `mobile-nav-link${isActive ? ' active' : ''}`}
                  key={route}
                  onClick={close}
                  to={prefixRoute(route)}
                >
                  <Icon aria-hidden size={18} />
                  <span>{label}</span>
                </NavLink>
              ))}
            </nav>

            <a
              aria-label="设置"
              className="mobile-nav-settings"
              href={`/plugins/${PLUGIN_BASE_URL.split('/').at(-1)}`}
              onClick={close}
            >
              <Settings aria-hidden size={18} />
              <span>设置</span>
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

interface FolderDropdownProps {
  activeFolder?: Folder;
  error: boolean;
  folders: Folder[];
  loading: boolean;
  onChange: (uid: string) => void;
  onRefresh: () => void;
}

function FolderDropdown({ activeFolder, error, folders, loading, onChange, onRefresh }: FolderDropdownProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const filteredFolders = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return normalized
      ? folders.filter(({ title, uid }) => `${title} ${uid}`.toLocaleLowerCase().includes(normalized))
      : folders;
  }, [folders, query]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const closeOnPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
        setQuery('');
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
        setQuery('');
        triggerRef.current?.focus();
      }
    };

    document.addEventListener('mousedown', closeOnPointerDown);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnPointerDown);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  return (
    <div className="folder-dropdown" ref={rootRef}>
      <button
        aria-controls="folder-selector"
        aria-expanded={open}
        aria-haspopup="dialog"
        className="topbar-folder"
        onClick={() => {
          setOpen((value) => !value);
          if (open) {
            setQuery('');
          }
        }}
        ref={triggerRef}
        type="button"
      >
        <span className="dot" />
        <FolderIcon aria-hidden size={13} />
        <span className="topbar-folder-name">
          Folder: {activeFolder?.title ?? (error ? '加载失败' : loading ? '加载中' : '无可用 Folder')}
        </span>
        {activeFolder && (
          <span className={`perm ${permissionClass(activeFolder.permission)}`}>{activeFolder.permission}</span>
        )}
        <ChevronDown aria-hidden size={13} />
      </button>

      {open && (
        <div aria-label="选择 Folder" className="folder-popover" id="folder-selector" role="dialog">
          <div className="folder-search">
            <Search aria-hidden size={13} />
            <input
              aria-label="搜索 Folder"
              autoFocus
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="搜索 Folder..."
              value={query}
            />
          </div>
          <div className="folder-list">
            <div className="folder-list-label">Grafana Folders</div>
            {loading && <div className="folder-empty">正在加载…</div>}
            {error && <div className="folder-empty">Folder 加载失败，请刷新重试</div>}
            {!loading && !error && filteredFolders.length === 0 && <div className="folder-empty">没有匹配的 Folder</div>}
            {filteredFolders.map((folder) => {
              const active = folder.uid === activeFolder?.uid;
              return (
                <button
                  className={`folder-option${active ? ' active' : ''}`}
                  key={folder.uid}
                  onClick={() => {
                    onChange(folder.uid);
                    setOpen(false);
                    setQuery('');
                    triggerRef.current?.focus();
                  }}
                  type="button"
                >
                  <FolderIcon aria-hidden size={14} />
                  <span className="folder-option-copy">
                    <strong>{folder.title}</strong>
                    <small>
                      uid: {folder.uid} · {folder.serviceCount} 个服务
                    </small>
                  </span>
                  <span className={`perm ${permissionClass(folder.permission)}`}>{folder.permission}</span>
                  {active && <Check aria-hidden size={13} />}
                </button>
              );
            })}
          </div>
          <div className="folder-popover-footer">
            <span>权限来自 Grafana Folder</span>
            <button aria-label="刷新 Folder" onClick={onRefresh} type="button">
              <RefreshCw aria-hidden size={13} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function permissionClass(permission: FolderPermission): string {
  return permission.toLocaleLowerCase();
}

function themeVariables(theme: GrafanaTheme2): React.CSSProperties {
  return {
    '--bg-base': theme.colors.background.canvas,
    '--bg-canvas': theme.colors.background.primary,
    '--bg-elev-1': theme.colors.background.primary,
    '--bg-elev-2': theme.colors.background.secondary,
    '--bg-elev-3': theme.colors.background.elevated,
    '--bg-hover': theme.colors.action.hover,
    '--border': theme.colors.border.weak,
    '--border-strong': theme.colors.border.medium,
    '--text-primary': theme.colors.text.primary,
    '--text-secondary': theme.colors.text.secondary,
    '--text-muted': theme.colors.text.disabled,
    '--accent': theme.colors.primary.main,
    '--accent-hover': theme.colors.primary.shade,
    '--accent-soft': theme.colors.primary.transparent,
    '--accent-contrast': theme.colors.primary.contrastText,
    '--orange': theme.visualization.getColorByName('orange'),
    '--green': theme.visualization.getColorByName('green'),
    '--red': theme.visualization.getColorByName('red'),
    '--yellow': theme.visualization.getColorByName('yellow'),
    '--purple': theme.visualization.getColorByName('purple'),
    '--cyan': theme.colors.success.main,
    '--shadow-1': theme.shadows.z1,
    '--shadow-2': theme.shadows.z2,
    '--font-mono': theme.typography.fontFamilyMonospace,
    '--font-sans': theme.typography.fontFamily,
  } as React.CSSProperties;
}
