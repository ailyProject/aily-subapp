import type { HTMLAttributes } from 'react';

export type FaIconName =
  | 'angle-left'
  | 'archive'
  | 'arrow-down'
  | 'arrow-left'
  | 'arrow-right'
  | 'arrow-up'
  | 'arrow-up-right-from-square'
  | 'book'
  | 'book-open'
  | 'brain'
  | 'broom-wide'
  | 'check'
  | 'chevron-down'
  | 'chevron-left'
  | 'chevron-right'
  | 'chevron-up'
  | 'circle'
  | 'circle-check'
  | 'circle-dot'
  | 'circle-exclamation'
  | 'circle-info'
  | 'circle-minus'
  | 'circle-notch'
  | 'circle-pause'
  | 'circle-question'
  | 'circle-xmark'
  | 'clock-rotate-left'
  | 'code-branch'
  | 'comment-smile'
  | 'copy'
  | 'cube'
  | 'download'
  | 'ellipsis'
  | 'envelope'
  | 'envelope-open'
  | 'eye'
  | 'file'
  | 'file-arrow-down'
  | 'file-circle-minus'
  | 'file-circle-plus'
  | 'file-code'
  | 'file-pen'
  | 'file-plus'
  | 'folder'
  | 'folder-plus'
  | 'forward'
  | 'forward-step'
  | 'gauge-simple-high'
  | 'gear'
  | 'hourglass-clock'
  | 'id-card'
  | 'key'
  | 'link'
  | 'list-check'
  | 'loader'
  | 'magnifying-glass'
  | 'message-exclamation'
  | 'message-lines'
  | 'paper-plane'
  | 'paperclip'
  | 'pen'
  | 'pen-line'
  | 'pen-to-square'
  | 'play'
  | 'plus'
  | 'puzzle-piece'
  | 'robot'
  | 'rotate-left'
  | 'rotate-right'
  | 'shield-check'
  | 'shield-exclamation'
  | 'sliders'
  | 'spinner-third'
  | 'star-christmas'
  | 'stop'
  | 'terminal'
  | 'thumbs-down'
  | 'thumbs-up'
  | 'thumbtack'
  | 'trash'
  | 'triangle-exclamation'
  | 'up-right-from-square'
  | 'user-astronaut'
  | 'user-vneck'
  | 'window-minimize'
  | 'xmark';

type FaIconProps = Omit<HTMLAttributes<HTMLElement>, 'children'> & {
  icon?: FaIconName | string;
  iconClass?: string;
  spin?: boolean;
};

function normalizeIconName(icon: string): string {
  return icon.startsWith('fa-') ? icon.slice(3) : icon;
}

function parseIconClass(iconClass: string): string[] {
  return iconClass.split(/\s+/).filter(Boolean);
}

export function FaIcon({
  icon,
  iconClass,
  spin = false,
  className,
  ...rest
}: FaIconProps) {
  const classes = iconClass
    ? parseIconClass(iconClass)
    : ['fa-light', icon ? `fa-${normalizeIconName(icon)}` : ''];

  if (spin) {
    classes.push('fa-spin', 'ac-spin');
  }

  if (className) {
    classes.push(className);
  }

  return <i className={classes.join(' ')} aria-hidden="true" {...rest} />;
}

/** @deprecated Use FaIcon instead */
export function Icon({ children }: { children: string }) {
  return <span className="icon" aria-hidden="true">{children}</span>;
}

export function resourceIcon(type: string): FaIconName {
  switch (type) {
    case 'folder':
      return 'folder';
    case 'url':
      return 'link';
    case 'block':
      return 'cube';
    default:
      return 'file';
  }
}
