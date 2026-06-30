import { useEffect, useMemo, useState } from 'react';
import { ChatSettings, invoke, t } from '../../protocol';
import { FaIcon } from '../shared/Icon';
import './aily-chat-settings.scss';

export function AilyChatSettings({
  value,
  onClose,
}: {
  value?: ChatSettings;
  onClose(): void;
}) {
  const [settings, setSettings] = useState<ChatSettings | undefined>(value);
  const [selectedAgent, setSelectedAgent] = useState('');
  const [editingModel, setEditingModel] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => setSettings(value), [value]);
  useEffect(() => {
    if (!selectedAgent && value?.agents[0]) setSelectedAgent(value.agents[0].id);
  }, [selectedAgent, value]);

  const agent = useMemo(
    () => settings?.agents.find(item => item.id === selectedAgent) || settings?.agents[0],
    [selectedAgent, settings],
  );

  if (!settings) {
    return <section className="settings-surface"><div className="settings-loading">{t('LOADING', '正在加载设置…')}</div></section>;
  }

  const patch = (next: Partial<ChatSettings>) => setSettings(current => current ? { ...current, ...next } : current);
  const patchLines = (key: keyof ChatSettings, text: string) => patch({
    [key]: text.split(/\r?\n/).map(item => item.trim()).filter(Boolean),
  } as Partial<ChatSettings>);

  async function save(): Promise<void> {
    setSaving(true);
    try {
      await invoke('settings.save', settings as unknown as Record<string, unknown>);
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="settings-surface">
      <header className="settings-header">
        <strong>{t('SETTINGS', 'Aily Chat 设置')}</strong>
        <button onClick={onClose}><FaIcon icon="xmark" /></button>
      </header>
      <div className="settings-scroll">
        <SettingsSection title="模型管理">
          <SettingBlock title="内置模型预设" hint="当前阶段用户侧只展示稳定预设。Auto 是软件内置默认 LLM；如需接入自定义模型，可在下方单独管理。">
            {settings.modelCatalogStatusHint && <p className="settings-warning">{settings.modelCatalogStatusHint}</p>}
            <div className="settings-list">
              {settings.modelPresets.map(preset => (
                <div className="settings-list-row" key={preset.id}>
                  <div><strong>{preset.name}</strong><small>{preset.id}</small><p>{preset.description}</p></div>
                  <div className="settings-tags"><span>预设</span>{preset.isDefault && <span className="success">默认</span>}{!preset.enabled && <span className="warning">不可用</span>}</div>
                </div>
              ))}
            </div>
          </SettingBlock>
          <SettingBlock title={`自定义模型 · ${settings.customModels.filter(model => model.enabled).length}/${settings.customModels.length} 已启用`}>
            <button className="settings-add-button" onClick={() => {
              patch({ customModels: [{ model: '', name: '', enabled: true, isCustom: true, baseUrl: '' }, ...settings.customModels] });
              setEditingModel(0);
            }}><FaIcon icon="plus" /> 添加自定义模型</button>
            <div className="settings-list">
              {settings.customModels.map((model, index) => editingModel === index ? (
                <div className="model-editor" key={`${model.model}-${index}`}>
                  <input value={model.name} placeholder="模型名称" onChange={event => updateModel(index, { name: event.target.value })} />
                  <input value={model.model} placeholder="模型 ID" onChange={event => updateModel(index, { model: event.target.value })} />
                  <input value={model.baseUrl} placeholder="Base URL" onChange={event => updateModel(index, { baseUrl: event.target.value })} />
                  <input type="password" value={model.apiKey || ''} placeholder={model.hasApiKey ? 'API Key（留空保持不变）' : 'API Key'} onChange={event => updateModel(index, { apiKey: event.target.value })} />
                  <div><button onClick={() => setEditingModel(null)}>完成</button><button className="danger" onClick={() => {
                    patch({ customModels: settings.customModels.filter((_, itemIndex) => itemIndex !== index) });
                    setEditingModel(null);
                  }}>删除</button></div>
                </div>
              ) : (
                <div className="settings-list-row" key={`${model.model}-${index}`}>
                  <label className="settings-check"><input type="checkbox" checked={model.enabled} onChange={event => updateModel(index, { enabled: event.target.checked })} /><span><strong>{model.name}</strong><small>{model.model}</small></span></label>
                  <button onClick={() => setEditingModel(index)}><FaIcon icon="pen" /></button>
                </div>
              ))}
            </div>
          </SettingBlock>
        </SettingsSection>

        <SettingsSection title="安全工作区">
          <div className="settings-list">
            {settings.workspaceOptions.map((option, index) => (
              <label className="settings-check settings-list-row" key={option.name}>
                <input type="checkbox" checked={option.enabled} onChange={event => {
                  const next = [...settings.workspaceOptions];
                  next[index] = { ...option, enabled: event.target.checked };
                  patch({ workspaceOptions: next });
                }} />
                <span>{option.displayName}</span>
              </label>
            ))}
          </div>
        </SettingsSection>

        <SettingsSection title="可用工具">
          <div className="settings-tabs">
            {settings.agents.map(item => <button key={item.id} data-active={item.id === agent?.id} onClick={() => setSelectedAgent(item.id)}>{item.label}</button>)}
          </div>
          {agent && <div className="settings-list">
            <label className="settings-check settings-list-row">
              <input type="checkbox" checked={agent.tools.every(tool => tool.enabled)} onChange={event => updateAllTools(agent.id, event.target.checked)} />
              <strong>全选 · {agent.tools.filter(tool => tool.enabled).length}/{agent.tools.length} 已启用</strong>
            </label>
            {agent.tools.map(tool => (
              <label className="settings-check settings-list-row" key={tool.name} title={tool.description}>
                <input type="checkbox" checked={tool.enabled} onChange={event => updateTool(agent.id, tool.name, event.target.checked)} />
                <span>{tool.displayName}</span>
              </label>
            ))}
          </div>}
        </SettingsSection>

        <SettingsSection title="其他设置">
          <PathSetting label="用户级 Instruction Folders" hint="每行一个绝对路径，lex 会递归扫描其中的 *.instructions.md。" value={settings.userInstructionFolders} onChange={value => patchLines('userInstructionFolders', value)} />
          <PathSetting label="项目级 Instruction Folders" hint="每行一个绝对路径，优先级低于用户级，高于仓库自动发现。" value={settings.projectInstructionFolders} onChange={value => patchLines('projectInstructionFolders', value)} />
          <PathSetting label="用户级 Agent Folders" hint="每行一个路径，作为默认 agent 目录之外的补充 source。" value={settings.userAgentFolders} onChange={value => patchLines('userAgentFolders', value)} />
          <PathSetting label="项目级 Agent Folders" hint="每行一个路径，作为项目 agent 目录之外的补充 source。" value={settings.projectAgentFolders} onChange={value => patchLines('projectAgentFolders', value)} />
          <Toggle label="存在 session customization provider 时，custom agents 优先使用该 source" checked={settings.useChatSessionCustomizationsForCustomAgents} onChange={value => patch({ useChatSessionCustomizationsForCustomAgents: value })} />
          <SettingBlock title="Custom Agent 可见性" hint="取消勾选后，该 custom agent 将从 mode picker 和 @agent suggestions 中隐藏。">
            {settings.customAgents.length ? settings.customAgents.map((item, index) => (
              <label className="settings-check settings-list-row" key={item.target}>
                <input type="checkbox" checked={item.visible} onChange={event => {
                  const next = [...settings.customAgents];
                  next[index] = { ...item, visible: event.target.checked };
                  patch({ customAgents: next });
                }} />
                <span><strong>{item.label}</strong>{item.description && <small>{item.description}</small>}</span>
              </label>
            )) : <p className="settings-hint">当前会话尚未发现可配置的 custom agent。</p>}
          </SettingBlock>
          <PathSetting label="Terminal 自动放行规则" hint="每行一个规则。支持命令前缀，或 /^...$/i 形式的正则字面量。" value={settings.terminalAllowList} onChange={value => patchLines('terminalAllowList', value)} />
          <PathSetting label="Terminal 强制确认规则" hint="命中这些规则时，即使是默认安全命令也会进入审批。" value={settings.terminalDenyList} onChange={value => patchLines('terminalDenyList', value)} />
          <Toggle label="继承 lex 内建 terminal allow list" checked={settings.terminalInheritDefaultAllowList} onChange={value => patch({ terminalInheritDefaultAllowList: value })} />
          <Toggle label="默认自动保存变更" checked={settings.autoSaveEdits} onChange={value => patch({ autoSaveEdits: value })} />
          <SettingBlock title="会话列表布局"><select value={settings.sessionViewerOrientation} onChange={event => patch({ sessionViewerOrientation: event.target.value as ChatSettings['sessionViewerOrientation'] })}><option value="sideBySide">并排优先（默认）</option><option value="stacked">始终堆叠</option></select></SettingBlock>
          <SettingBlock title="最大请求数（工具调用轮数）"><input type="number" min={1} value={settings.maxRequests} onChange={event => patch({ maxRequests: Number(event.target.value) })} /></SettingBlock>
        </SettingsSection>
      </div>
      <footer className="settings-footer"><button onClick={onClose}>返回</button><button className="primary" disabled={saving} onClick={() => void save()}>{saving ? '保存中…' : '保存'}</button></footer>
    </section>
  );

  function updateModel(index: number, update: Partial<ChatSettings['customModels'][number]>) {
    const next = [...settings!.customModels];
    next[index] = { ...next[index], ...update };
    patch({ customModels: next });
  }

  function updateAllTools(agentId: string, enabled: boolean) {
    patch({ agents: settings!.agents.map(item => item.id === agentId ? { ...item, tools: item.tools.map(tool => ({ ...tool, enabled })) } : item) });
  }

  function updateTool(agentId: string, toolName: string, enabled: boolean) {
    patch({ agents: settings!.agents.map(item => item.id === agentId ? { ...item, tools: item.tools.map(tool => tool.name === toolName ? { ...tool, enabled } : tool) } : item) });
  }
}

function SettingsSection({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="settings-section"><h2>{title}</h2>{children}</section>;
}

function SettingBlock({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return <div className="setting-block"><strong>{title}</strong>{hint && <p className="settings-hint">{hint}</p>}{children}</div>;
}

function PathSetting({ label, hint, value, onChange }: { label: string; hint: string; value: string[]; onChange(value: string): void }) {
  return <SettingBlock title={label} hint={hint}><textarea rows={3} value={value.join('\n')} onChange={event => onChange(event.target.value)} /></SettingBlock>;
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange(value: boolean): void }) {
  return <label className="settings-check setting-toggle"><input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} /><span>{label}</span></label>;
}
