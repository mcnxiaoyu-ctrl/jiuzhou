import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { ConfigProvider, App as AntdApp, Button, Modal, Spin, theme as antdTheme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import Auth from './pages/Auth';
import {
  getAuthBootstrap,
  API_ERROR_TOAST_EVENT,
  isAuthExpiredApiError,
  isSessionKickedApiError,
  isTemporaryUnavailableApiError,
  toUnifiedApiError,
  type ApiErrorToastDetail,
} from './services/api';
import { gameSocket } from './services/gameSocket';
import { THEME_EVENT_NAME, applyThemeModeToDocument, type ThemeMode } from './constants/theme';
import AppUpdateNotifier from './components/AppUpdateNotifier';
import './App.css';
import './App.scss';

// 懒加载 Game 组件，减少首屏加载体积
const Game = lazy(() => import('./pages/Game'));

const TOKEN_STORAGE_KEY = 'token';
const USER_STORAGE_KEY = 'user';
const AUTH_BOOTSTRAP_RETRY_DELAY_MS = 5_000;
const AUTH_RECOVERY_UNAVAILABLE_MESSAGE = '服务器正在更新或暂时不可用，正在保留登录状态并自动重试。';
const centeredViewportStyle = {
  display: 'flex',
  justifyContent: 'center',
  alignItems: 'center',
  minHeight: '100dvh',
  height: '100%',
} as const;
const authRecoveryViewportStyle = {
  ...centeredViewportStyle,
  flexDirection: 'column',
  gap: 12,
  padding: 24,
  textAlign: 'center',
  background: 'var(--app-bg)',
  color: 'var(--text-color)',
} as const;
const authRecoveryMessageStyle = {
  maxWidth: 360,
  lineHeight: 1.6,
} as const;
const modalThemeCompat: Record<string, number> = { contentPadding: 8 };
const buttonThemeCompat = {
  defaultColor: 'var(--text-color)',
  defaultBg: 'var(--panel-bg-soft)',
  defaultBorderColor: 'var(--border-color)',
  defaultHoverColor: 'var(--text-color)',
  defaultHoverBg: 'var(--hover-bg)',
  defaultHoverBorderColor: 'var(--border-color)',
  defaultActiveColor: 'var(--text-color)',
  defaultActiveBg: 'var(--active-bg)',
  defaultActiveBorderColor: 'var(--border-color)',
  defaultShadow: 'none',
  primaryShadow: 'none',
  dangerShadow: 'none',
  textTextColor: 'var(--text-color)',
  textTextHoverColor: 'var(--text-color)',
  textTextActiveColor: 'var(--text-color)',
  textHoverBg: 'var(--hover-bg)',
  linkHoverBg: 'var(--hover-bg)',
} as const;

const ApiErrorToastBridge: React.FC = () => {
  const { message } = AntdApp.useApp();

  useEffect(() => {
    const handler = (event: Event) => {
      const customEvent = event as CustomEvent<ApiErrorToastDetail>;
      const text = String(customEvent.detail?.message || '').trim();
      if (!text) return;
      message.error(text);
    };
    window.addEventListener(API_ERROR_TOAST_EVENT, handler as EventListener);
    return () => window.removeEventListener(API_ERROR_TOAST_EVENT, handler as EventListener);
  }, [message]);

  return null;
};

const clearAuthStorage = () => {
  localStorage.removeItem(TOKEN_STORAGE_KEY);
  localStorage.removeItem(USER_STORAGE_KEY);
};

interface AppProps {
  initialThemeMode: ThemeMode;
}

function App({ initialThemeMode }: AppProps) {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [themeMode, setThemeMode] = useState<ThemeMode>(initialThemeMode);
  const [authRecoveryMessage, setAuthRecoveryMessage] = useState<string | null>(null);
  const [authRecoveryRetryKey, setAuthRecoveryRetryKey] = useState(0);

  const retryAuthRecovery = useCallback(() => {
    setIsLoading(true);
    setAuthRecoveryMessage(null);
    setAuthRecoveryRetryKey((current) => current + 1);
  }, []);

  const antdThemeConfig = useMemo(() => ({
    algorithm: themeMode === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: {
      colorPrimary: 'var(--primary-color)',
    },
    components: {
      Button: buttonThemeCompat,
      Modal: {
        contentBg: 'var(--panel-bg)',
        ...modalThemeCompat,
      },
    },
  }), [themeMode]);

  // 持久登录检查
  useEffect(() => {
    let retryTimerId: number | null = null;

    const scheduleAuthRecoveryRetry = () => {
      retryTimerId = window.setTimeout(() => {
        retryAuthRecovery();
      }, AUTH_BOOTSTRAP_RETRY_DELAY_MS);
    };

    const checkAuth = async () => {
      const token = localStorage.getItem(TOKEN_STORAGE_KEY);
      if (!token) {
        setAuthRecoveryMessage(null);
        setIsLoading(false);
        return;
      }

      try {
        const result = await getAuthBootstrap();
        setAuthRecoveryMessage(null);
        if (result.success) {
          if (result.data?.hasCharacter) {
            setIsLoggedIn(true);
          }
        } else {
          // 清除无效的登录信息
          clearAuthStorage();
          if (result.kicked) {
            Modal.warning({
              title: '登录已失效',
              content: '您的账号已在其他设备登录',
            });
          }
        }
      } catch (error) {
        const normalizedError = toUnifiedApiError(error, '登录状态检查失败');
        if (isAuthExpiredApiError(normalizedError)) {
          clearAuthStorage();
          if (isSessionKickedApiError(normalizedError)) {
            Modal.warning({
              title: '登录已失效',
              content: normalizedError.message || '您的账号已在其他设备登录',
            });
          }
          return;
        }

        if (isTemporaryUnavailableApiError(normalizedError)) {
          setAuthRecoveryMessage(AUTH_RECOVERY_UNAVAILABLE_MESSAGE);
          scheduleAuthRecoveryRetry();
          return;
        }

        setAuthRecoveryMessage(AUTH_RECOVERY_UNAVAILABLE_MESSAGE);
        scheduleAuthRecoveryRetry();
      } finally {
        setIsLoading(false);
      }
    };

    checkAuth();

    return () => {
      if (retryTimerId !== null) {
        window.clearTimeout(retryTimerId);
      }
    };
  }, [authRecoveryRetryKey, retryAuthRecovery]);

  useEffect(() => {
    applyThemeModeToDocument(themeMode);
  }, [themeMode]);

  useEffect(() => {
    const onThemeEvent = (e: Event) => {
      const ce = e as CustomEvent<{ mode?: ThemeMode }>;
      const mode = ce.detail?.mode;
      if (mode === 'dark' || mode === 'light') {
        setThemeMode(mode);
      }
    };

    window.addEventListener(THEME_EVENT_NAME, onThemeEvent);
    return () => window.removeEventListener(THEME_EVENT_NAME, onThemeEvent);
  }, []);

  // 监听被踢出事件
  useEffect(() => {
    const handleKicked = (data: { message: string }) => {
      clearAuthStorage();
      setIsLoggedIn(false);
      Modal.warning({
        title: '登录已失效',
        content: data.message || '您的账号已在其他设备登录',
      });
    };

    const unsubscribe = gameSocket.onKicked(handleKicked);
    return () => unsubscribe();
  }, []);

  const handleLogout = () => {
    clearAuthStorage();
    gameSocket.disconnect();
    setIsLoggedIn(false);
  };

  if (isLoading) {
    return (
      <ConfigProvider locale={zhCN} theme={antdThemeConfig}>
        <div
          style={{
            ...centeredViewportStyle,
            background: 'var(--app-bg)',
            color: 'var(--text-color)',
          }}
        >
          加载中...
        </div>
      </ConfigProvider>
    );
  }

  if (authRecoveryMessage) {
    return (
      <ConfigProvider locale={zhCN} theme={antdThemeConfig}>
        <div style={authRecoveryViewportStyle}>
          <Spin size="large" />
          <div style={authRecoveryMessageStyle}>{authRecoveryMessage}</div>
          <Button type="primary" onClick={retryAuthRecovery}>
            立即重试
          </Button>
        </div>
      </ConfigProvider>
    );
  }

  return (
    <ConfigProvider
      locale={zhCN}
      theme={antdThemeConfig}
    >
      <AntdApp>
        <ApiErrorToastBridge />
        <AppUpdateNotifier />
        {isLoggedIn ? (
          <Suspense
            fallback={
              <div
                style={{
                  ...centeredViewportStyle,
                }}
              >
                <Spin size="large" tip="加载游戏中...">
                  <div style={{ width: 140, height: 80 }} />
                </Spin>
              </div>
            }
          >
            <Game onLogout={handleLogout} />
          </Suspense>
        ) : (
          <Auth onLoginSuccess={() => setIsLoggedIn(true)} />
        )}
      </AntdApp>
    </ConfigProvider>
  );
}

export default App;
