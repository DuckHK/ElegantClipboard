/**
 * 模块级主题应用器，零 React 开销。
 *
 * 每个窗口调用一次 `initTheme()`：
 * - 应用颜色主题 class 到 <html>
 * - 获取系统强调色并设置 --system-accent-h
 * - 监听后端 WM_SETTINGCHANGE 事件
 * - 订阅 zustand store 主题切换
 * - 通过 matchMedia 应用深色模式
 *
 * 返回 Promise，主题完全应用后 resolve。
 */
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { useUISettings } from "@/stores/ui-settings";

const THEME_CLASSES = ["theme-emerald", "theme-cyan", "theme-system"];

let _initialized = false;
let _accentColor: string | null = null;
let _readyResolve: (() => void) | null = null;
let _lastTextPreviewTheme: "dark" | "light" | null = null;
const _readyPromise = new Promise<void>((resolve) => {
  _readyResolve = resolve;
});

// 强调色变更订阅者（主题预览用）
const _accentSubscribers = new Set<(color: string | null) => void>();

function notifyAccentSubscribers() {
  _accentSubscribers.forEach((fn) => fn(_accentColor));
}

function applySharpCorners() {
  const { sharpCorners } = useUISettings.getState();
  document.documentElement.classList.toggle("sharp-corners", sharpCorners);
}

function getIsDark(): boolean {
  const { darkMode } = useUISettings.getState();
  if (darkMode === "dark") return true;
  if (darkMode === "light") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function applyWindowEffect() {
  const { windowEffect } = useUISettings.getState();
  if (windowEffect === "none") {
    // 移除特效：立即清除 CSS 透明
    document.documentElement.setAttribute("data-window-effect", "none");
    invoke("set_window_effect", { effect: "none", dark: null }).catch(() => {});
  } else {
    // 应用特效：先设 DWM 背景，再激活 CSS 透明
    const dark = getIsDark();
    invoke("set_window_effect", { effect: windowEffect, dark })
      .then(() => {
        document.documentElement.setAttribute("data-window-effect", windowEffect);
      })
      .catch(() => {
        // 特效不支持（如 Win10 不支持 Mica/Tabbed），回退
        document.documentElement.setAttribute("data-window-effect", "none");
        useUISettings.setState({ windowEffect: "none" });
      });
  }
}

function apply() {
  const { colorTheme } = useUISettings.getState();
  const root = document.documentElement;

  root.classList.remove(...THEME_CLASSES);
  root.style.removeProperty("--system-accent-h");
  root.style.removeProperty("--system-accent-s");
  root.style.removeProperty("--system-accent-l");

  if (colorTheme === "system" && _accentColor) {
    const parts = _accentColor.split(" ");
    root.classList.add("theme-system");
    root.style.setProperty("--system-accent-h", parts[0]);
    root.style.setProperty("--system-accent-s", parts[1] || "65%");
    root.style.setProperty("--system-accent-l", parts[2] || "50%");
  } else if (colorTheme !== "default" && colorTheme !== "system") {
    root.classList.add(`theme-${colorTheme}`);
  }
}

/** 初始化主题系统，可安全多次调用，每个窗口仅执行一次 */
export function initTheme(): Promise<void> {
  if (_initialized) return _readyPromise;
  _initialized = true;

  // --- 深色模式 ---
  const mq = window.matchMedia("(prefers-color-scheme: dark)");

  function applyDarkMode() {
    const { darkMode } = useUISettings.getState();
    const isDark =
      darkMode === "dark" ? true : darkMode === "light" ? false : mq.matches;
    document.documentElement.classList.toggle("dark", isDark);
    const nextTextPreviewTheme = isDark ? "dark" : "light";
    if (nextTextPreviewTheme !== _lastTextPreviewTheme) {
      _lastTextPreviewTheme = nextTextPreviewTheme;
      if (useUISettings.getState().textPreviewEnabled) {
        emitTo("text-preview", "text-preview-theme", {
          theme: nextTextPreviewTheme,
        }).catch(() => {});
      }
    }
  }

  applyDarkMode();
  mq.addEventListener("change", () => applyDarkMode());

  // --- 订阅 store 变更：主题/圆角/深色模式变化时重新应用 ---
  useUISettings.subscribe((state, prev) => {
    if (state.sharpCorners !== prev.sharpCorners) {
      applySharpCorners();
    }
    if (state.windowEffect !== prev.windowEffect) {
      applyWindowEffect();
    }
    if (state.darkMode !== prev.darkMode) {
      applyDarkMode();
      // 重新应用窗口特效以匹配深色模式
      if (state.windowEffect !== "none") {
        applyWindowEffect();
      }
    }
    if (state.colorTheme !== prev.colorTheme) {
      if (state.colorTheme === "system" && !_accentColor) {
        // 切换到系统主题但还未获取强调色
        invoke<string | null>("get_system_accent_color").then((color) => {
          _accentColor = color;
          apply();
        });
      } else {
        apply();
      }
    }
  });

  // --- 后端推送新强调色（无需重新 IPC） ---
  listen<string | null>("system-accent-color-changed", (event) => {
    _accentColor = event.payload;
    notifyAccentSubscribers();
    apply();
  });

  // --- 初始化应用 ---
  applySharpCorners();
  applyWindowEffect();
  // 始终获取强调色以供主题预览使用
  invoke<string | null>("get_system_accent_color")
    .then((color) => {
      _accentColor = color;
      notifyAccentSubscribers();
      apply();
    })
    .catch(() => apply())
    .finally(() => _readyResolve?.());

  return _readyPromise;
}

/** 读取缓存的强调色（主题预览用） */
export function getAccentColor(): string | null {
  return _accentColor;
}

/** 订阅强调色变更，返回取消函数 */
export function subscribeAccentColor(
  fn: (color: string | null) => void,
): () => void {
  _accentSubscribers.add(fn);
  return () => _accentSubscribers.delete(fn);
}
