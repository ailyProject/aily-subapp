import { MouseEvent as ReactMouseEvent, useState } from 'react';
import { t } from '../../protocol';
import { FaIcon } from '../shared/Icon';
import './edit-context-toolbar.scss';

function modeIconClass(modeId: string): string {
  if (modeId === 'ask') return 'fa-light fa-comment-smile';
  if (modeId === 'plan') return 'fa-light fa-list-check';
  if (modeId === 'edit') return 'fa-light fa-pen-line';
  return 'fa-light fa-user-astronaut';
}

export function EditContextToolbar({
  modeId,
  modeLabel,
  modelLabel,
  showModelChip = true,
  onModeClick,
  onModelClick,
  onAddFile,
  onAddFolder,
}: {
  modeId: string;
  modeLabel: string;
  modelLabel: string;
  showModelChip?: boolean;
  onModeClick(event: ReactMouseEvent<HTMLButtonElement>): void;
  onModelClick(event: ReactMouseEvent<HTMLButtonElement>): void;
  onAddFile(): void;
  onAddFolder(): void;
}) {
  const [showAddList, setShowAddList] = useState(false);

  return (
    <div className="edit-context-toolbar">
      <button
        type="button"
        className="acc-clip"
        title={t('ATTACH', '添加上下文')}
        onClick={() => setShowAddList(value => !value)}
      >
        <FaIcon icon={showAddList ? 'angle-left' : 'paperclip'} />
      </button>
      {showAddList && (
        <>
          <span className="acc-expand-backdrop" aria-hidden="true" />
          <button
            type="button"
            className="acc-back"
            title={t('ATTACH', '添加上下文')}
            onClick={() => setShowAddList(false)}
          >
            <FaIcon icon="angle-left" />
          </button>
          <button
            type="button"
            className="acc-sub"
            title={t('ADD_FILE', '添加文件')}
            onClick={() => {
              onAddFile();
              setShowAddList(false);
            }}
          >
            <FaIcon icon="file-plus" />
          </button>
          <button
            type="button"
            className="acc-sub"
            title={t('ADD_FOLDER', '添加文件夹')}
            onClick={() => {
              onAddFolder();
              setShowAddList(false);
            }}
          >
            <FaIcon icon="folder-plus" />
          </button>
        </>
      )}
      <button
        type="button"
        className={`acc-chip ${showAddList ? 'acc-chip--after-expanded-context' : ''}`}
        title={modeLabel}
        onClick={onModeClick}
      >
        <FaIcon iconClass={modeIconClass(modeId)} />
        <span>{modeLabel}</span>
      </button>
      {showModelChip && modelLabel && (
        <button
          type="button"
          className={`acc-chip ${showAddList ? 'acc-chip--after-expanded-context' : ''}`}
          title={modelLabel}
          onClick={onModelClick}
        >
          <FaIcon icon="star-christmas" />
          <span>{modelLabel}</span>
        </button>
      )}
    </div>
  );
}
