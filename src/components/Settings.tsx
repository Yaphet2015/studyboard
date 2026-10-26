import ofl from "lxgw-wenkai-webfont/OFL.txt?raw";
import { useEffect, useRef, useState } from "react";
import {
  Archive,
  Download,
  HardDrive,
  Upload,
  Info,
  Sprout,
  Keyboard,
  KeyRound,
  LockKeyhole,
  Palette as PaletteIcon,
  Sparkles,
  X,
} from "lucide-react";
import type {
  BoardSummary,
  AIConnectionResult,
  AISettings,
  AISettingsInput,
} from "../shared/types";
import { emptyProfile } from "../shared/profile";
import { profileClock } from "../model/profile-clock";
import { api, isDesktop } from "../api";
import {
  connectionStatusText,
  type ConnectionTestState,
} from "../model/connection";
import { SHORTCUTS, MOD } from "../model/shortcuts";
import pkg from "../../package.json";
import { tip } from "./Tooltip";

/**
 * The API key row. A saved key is shown only masked; the plaintext never comes back from the
 * main process. "更换" reveals an input, "清除" removes the saved copy.
 */
export function ApiKeyField({
  settings,
  value,
  onChange,
  onClear,
  disabled,
  label = "API 密钥",
}: {
  settings: Pick<AISettings, "source" | "keyHint" | "keyStorage">;
  value: string;
  onChange: (value: string) => void;
  onClear: () => void;
  disabled?: boolean;
  label?: string;
}) {
  const hasKey = settings.source === "saved" || settings.source === "session";
  const [replacing, setReplacing] = useState(!hasKey);
  // After saving or clearing, show the saved state again.
  useEffect(() => setReplacing(!hasKey), [hasKey, settings.keyHint]);
  const where =
    settings.source === "saved"
      ? "已加密保存在本机钥匙串"
      : settings.source === "session"
        ? "仅本次运行，退出后需重新输入"
        : settings.source === "environment"
          ? "使用环境变量 OPENAI_API_KEY"
          : "";
  return (
    <div className="key-field">
      <span className="key-label">{label}</span>
      {hasKey || settings.source === "environment" ? (
        <div className="key-saved" data-source={settings.source}>
          <KeyRound size={15} className="ico" />
          <span className="mask" aria-label="已保存的密钥（已遮盖）">
            {settings.keyHint ?? "••••"}
          </span>
          <span className="where">{where}</span>
          {hasKey && !disabled && (
            <span className="key-acts">
              {!replacing && (
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => setReplacing(true)}
                >
                  更换
                </button>
              )}
              <button type="button" className="btn sm" onClick={onClear}>
                清除
              </button>
            </span>
          )}
        </div>
      ) : null}
      {(replacing || !hasKey) && (
        <input
          type="password"
          aria-label={label}
          autoComplete="off"
          spellCheck={false}
          value={value}
          placeholder={
            hasKey ? "输入新的 API key 替换当前密钥" : "输入你的 API key"
          }
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
        />
      )}
      {settings.keyStorage === "unavailable" && (
        <p className="key-warn" role="note">
          这台电脑的系统钥匙串不可用，无法加密保存密钥：密钥只保留到退出应用。
        </p>
      )}
    </div>
  );
}

type Section = "profile" | "ai" | "appearance" | "data" | "archive" | "shortcuts" | "about";
const SECTIONS: [Section, string, React.ReactNode][] = [
  ["profile", "学习画像", <Sprout size={16} className="ico" />],
  ["ai", "AI 服务", <Sparkles size={16} className="ico" />],
  ["appearance", "外观", <PaletteIcon size={16} className="ico" />],
  ["data", "画板数据", <HardDrive size={16} className="ico" />],
  ["archive", "已归档画布", <Archive size={16} className="ico" />],
  ["shortcuts", "快捷键", <Keyboard size={16} className="ico" />],
  ["about", "关于与许可", <Info size={16} className="ico" />],
];

/** The settings page: a full view over the canvas, opened with ⌘. / Ctrl+. or from ⌘K. Esc closes. */
export function Settings({
  settings,
  dark,
  onTheme,
  onClose,
  onSave,
  onTest,
  archivedBoards,
  archiveBusy,
  onRestore,
  boardTitle,
  transferBusy,
  onImport,
  onExport,
  initial = "ai",
}: {
  settings: AISettings;
  dark: boolean;
  onTheme: (dark: boolean) => void;
  onClose: () => void;
  onSave: (s: AISettingsInput) => Promise<void>;
  onTest: (s: AISettingsInput) => Promise<AIConnectionResult>;
  archivedBoards: BoardSummary[];
  archiveBusy: boolean;
  onRestore: (id: string) => void;
  boardTitle?: string;
  transferBusy: boolean;
  onImport: () => void;
  onExport: () => void;
  initial?: Section;
}) {
  const [profile, setProfile] = useState(emptyProfile);
  useEffect(() => {
    let live = true;
    void api.getProfile().then(value => { if (live) setProfile(value); }).catch(() => undefined);
    const off = api.onProfileChanged?.(setProfile);
    return () => { live = false; off?.(); };
  }, []);
  const [section, setSection] = useState<Section>(initial);
  const [model, setModel] = useState(settings.model),
    [endpoint, setEndpoint] = useState(settings.baseUrl),
    [key, setKey] = useState(""),
    [searchKey, setSearchKey] = useState(""),
    [customInstructions, setCustomInstructions] = useState(
      settings.customInstructions ?? "",
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(""),
    [test, setTest] = useState<ConnectionTestState>({ phase: "idle" });
  const body = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    root.current?.focus();
  }, []);
  const draft = (): AISettingsInput => ({
    model,
    baseUrl: endpoint,
    customInstructions,
    ...(key ? { apiKey: key } : {}),
    ...(searchKey ? { deepseekApiKey: searchKey } : {}),
  });
  // Edits invalidate an earlier result so it never describes different settings.
  const edited =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      set(value);
      setSaved("");
      setTest({ phase: "idle" });
    };
  const runTest = async () => {
    setTest({ phase: "testing" });
    try {
      setTest({ phase: "done", result: await onTest(draft()) });
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error);
      setTest({
        phase: "done",
        result: {
          ok: false,
          kind: "unknown",
          message: /Invalid|url|URL/.test(message)
            ? "设置格式不对：请检查 API 地址（远程地址需 https）和模型 ID。"
            : "测试没有完成，请检查设置后重试。",
        },
      });
    }
  };
  const save = async (input: AISettingsInput, done: string) => {
    setBusy(true);
    setError("");
    try {
      await onSave(input);
      setKey("");
      setSearchKey("");
      setSaved(done);
    } catch (error) {
      setError(String(error instanceof Error ? error.message : error));
    } finally {
      setBusy(false);
    }
  };
  const groups = [...new Set(SHORTCUTS.map((s) => s.group))];
  return (
    <section
      ref={root}
      tabIndex={-1}
      className="settings-page"
      lang="zh-CN"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="settings-head">
        <h1 id="settings-title">设置</h1>
        <span className="lab">{MOD}. 打开 · Esc 关闭</span>
        <button className="ib" {...tip("关闭设置", "Esc")} onClick={onClose}>
          <X size={18} />
        </button>
      </header>
      <div className="settings-main">
        <nav className="settings-nav" aria-label="设置分区">
          {SECTIONS.map(([id, label, icon]) => (
            <button
              key={id}
              className={section === id ? "on" : ""}
              aria-current={section === id ? "page" : undefined}
              onClick={() => {
                setSection(id);
                body.current?.scrollTo({ top: 0 });
              }}
            >
              {icon}
              {label}
            </button>
          ))}
        </nav>
        <div className="settings-body" ref={body}>
          {section === "profile" && (
            <div className="settings-section profile-section" aria-labelledby="sec-profile">
              <h2 id="sec-profile">学习画像</h2>
              <p className="profile-lede">这是我目前对你的了解，学习时我会据此调整讲法。</p>
              {profile.text.trim() ? (
                <article className="profile-card" aria-labelledby="sec-profile">
                  <p className="profile-text">{profile.text}</p>
                  {profile.updatedAt && profileClock(profile.updatedAt) && (
                    <footer className="profile-updated">最近更新于 <time dateTime={profile.updatedAt}>{profileClock(profile.updatedAt)}</time></footer>
                  )}
                </article>
              ) : (
                <p className="profile-empty">还没有画像。做一次摸底，或把卡片学懂，我就会开始了解你。</p>
              )}
            </div>
          )}
          {section === "ai" && (
            <div className="settings-section" aria-labelledby="sec-ai">
              <h2 id="sec-ai">AI 服务</h2>
              <p className="sec-lede">
                内置演练可以离线使用。探索其他主题、展开概念、批注问答和画布上的灰色提示，需要你自己的模型
                API。
              </p>
              {!isDesktop && (
                <div className="setup-notice">
                  这是浏览器预览：API
                  设置只在桌面客户端中可用，这里不会接收或保存密钥。
                </div>
              )}
              <form
                className="settings-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void save(draft(), "已保存。发出提问时才会调用模型。");
                }}
              >
                <label>
                  <span className="key-label">API 地址</span>
                  <input
                    type="url"
                    required
                    value={endpoint}
                    onChange={(e) => edited(setEndpoint)(e.target.value)}
                    disabled={!isDesktop}
                  />
                </label>
                <label>
                  <span className="key-label">模型 ID</span>
                  <input
                    value={model}
                    required
                    placeholder="gpt-4o-mini"
                    onChange={(e) => edited(setModel)(e.target.value)}
                    disabled={!isDesktop}
                  />
                </label>
                <ApiKeyField
                  settings={settings}
                  value={key}
                  onChange={edited(setKey)}
                  disabled={!isDesktop}
                  onClear={() =>
                    void save({ ...draft(), apiKey: "" }, "已清除保存的密钥。")
                  }
                />
                <label>
                  <span className="key-label">Agent 自定义指令</span>
                  <textarea
                    aria-label="Agent 自定义指令"
                    value={customInstructions}
                    maxLength={8000}
                    rows={5}
                    placeholder="例如：先给结论，每次只解释一个概念，多用生活中的例子。"
                    onChange={(e) =>
                      edited(setCustomInstructions)(e.target.value)
                    }
                    disabled={!isDesktop}
                  />
                  <small className="settings-foot">
                    保存后用于后续问答和画布 Agent
                    的系统提示词。留空恢复默认；最多 8000 字。
                  </small>
                </label>
                <ApiKeyField
                  label="DeepSeek 搜索备用密钥"
                  settings={{
                    source: settings.searchKey?.source ?? "none",
                    keyHint: settings.searchKey?.keyHint,
                    keyStorage: settings.keyStorage,
                  }}
                  value={searchKey}
                  onChange={edited(setSearchKey)}
                  disabled={!isDesktop}
                  onClear={() =>
                    void save(
                      { ...draft(), deepseekApiKey: "" },
                      "已清除搜索备用密钥。",
                    )
                  }
                />
                <p className="settings-foot">
                  联网搜索和网页读取优先使用免费 Exa；配置此密钥后，Exa
                  调用失败时会尝试 DeepSeek，可能产生费用。
                </p>
                <div className="privacy-note">
                  <LockKeyhole size={16} />
                  <span>
                    密钥只交给桌面主进程，用系统钥匙串（safeStorage）加密后保存在本机，界面只显示末四位。提问或生成卡片时，起点主题、当前对话、选入的资料和生成位置上下各
                    4 层的卡片内容会发送到上方 API 服务商，可能产生费用。
                  </span>
                </div>
                {error && <div className="inline-error">{error}</div>}
                <div className="settings-actions">
                  <button
                    type="button"
                    className="btn"
                    disabled={!isDesktop || busy || test.phase === "testing"}
                    onClick={() => void runTest()}
                  >
                    {test.phase === "testing" ? "测试中…" : "测试连接"}
                  </button>
                  <span
                    className="connection-status"
                    data-state={
                      test.phase === "done"
                        ? test.result.ok
                          ? "success"
                          : "failure"
                        : test.phase
                    }
                    role="status"
                    aria-live="polite"
                  >
                    {connectionStatusText(test) || saved}
                  </span>
                  <button
                    className="btn primary"
                    type="submit"
                    disabled={!isDesktop || busy}
                  >
                    {busy ? "保存中…" : "保存"}
                  </button>
                </div>
                <p className="settings-foot">
                  保存不会调用模型；「测试连接」会用上面填写的设置发一次极短的请求（可能产生极少费用），不会保存。
                </p>
              </form>
            </div>
          )}
          {section === "appearance" && (
            <div className="settings-section">
              <h2>外观</h2>
              <div className="setting-row">
                <span>
                  <b>主题</b>
                  <small>也可以在画布上按 D 切换</small>
                </span>
                <div className="seg" role="radiogroup" aria-label="主题">
                  {(
                    [
                      [false, "浅色"],
                      [true, "深色"],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={label}
                      role="radio"
                      aria-checked={dark === value}
                      className={dark === value ? "on" : ""}
                      onClick={() => onTheme(value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="setting-row">
                <span>
                  <b>字体</b>
                  <small>霞鹜文楷 LXGW WenKai，随应用离线打包</small>
                </span>
              </div>
            </div>
          )}
          {section === "data" && (
            <div className="settings-section" aria-labelledby="sec-data">
              <h2 id="sec-data">画板数据</h2>
              <p className="sec-lede">
                导入画板可恢复学习记录和对话。导出时可选择画板数据、Markdown
                或截图。
              </p>
              <div className="setting-row">
                <span>
                  <b>导入画板</b>
                  <small>从之前导出的画板数据文件恢复</small>
                </span>
                <button
                  className="btn"
                  disabled={transferBusy}
                  onClick={onImport}
                >
                  <Upload size={16} className="ico" />
                  导入画板
                </button>
              </div>
              <div className="setting-row">
                <span>
                  <b>导出当前画板</b>
                  <small>{boardTitle ?? "请先打开一张画板"}</small>
                </span>
                <button
                  className="btn"
                  disabled={transferBusy || !boardTitle}
                  onClick={onExport}
                >
                  <Download size={16} className="ico" />
                  导出画板
                </button>
              </div>
            </div>
          )}
          {section === "archive" && (
            <div className="settings-section" aria-labelledby="sec-archive">
              <h2 id="sec-archive">已归档画布</h2>
              <p className="sec-lede">
                归档的画布保留全部卡片和对话。恢复后会重新显示在侧栏。
              </p>
              {archivedBoards.length === 0 && <p>还没有归档的画布。</p>}
              {archivedBoards.map((b) => (
                <div className="setting-row" key={b.id}>
                  <span>
                    <b>{b.title}</b>
                    <small>
                      归档于 {new Date(b.archivedAt!).toLocaleString()}
                    </small>
                  </span>
                  <button
                    className="btn"
                    disabled={archiveBusy}
                    onClick={() => onRestore(b.id)}
                  >
                    恢复
                  </button>
                </div>
              ))}
            </div>
          )}
          {section === "shortcuts" && (
            <div className="settings-section">
              <h2>快捷键</h2>
              {groups.map((g) => (
                <div key={g} className="shortcut-group">
                  <h3 className="lab">{g}</h3>
                  <dl>
                    {SHORTCUTS.filter((s) => s.group === g).map((s) => (
                      <div key={s.label} className="shortcut">
                        <dt>{s.label}</dt>
                        <dd>
                          <kbd className="kbd">{s.keys}</kbd>
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
              ))}
            </div>
          )}
          {section === "about" && (
            <div className="settings-section">
              <h2>关于与许可</h2>
              <div className="setting-row">
                <span>
                  <b>Studyboard</b>
                  <small>版本 {pkg.version} · 白板保存在这台设备上</small>
                </span>
              </div>
              <p className="sec-lede">
                字体：霞鹜文楷 LXGW WenKai / LXGW WenKai
                Mono（随应用离线打包），以 SIL Open Font License 1.1
                授权。图标：Lucide（ISC 许可）。对话抽屉的思考与流式动效参考了
                Beautiful UI（MIT 许可，© 2026 Shane
                Levine）的设计，按本应用的样式重写，未复制其代码。
              </p>
              <details className="licenses">
                <summary>SIL Open Font License 1.1 全文</summary>
                <pre>{ofl}</pre>
              </details>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
