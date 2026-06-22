import type { CSSProperties, HTMLAttributes } from 'react';
import type { FaLightIconName } from '../../icons/registry';
import { faLight } from '../../icons/registry';

type FaIconProps = Omit<HTMLAttributes<HTMLElement>, 'children'> & {
  /** Full class string, e.g. `fa-light fa-folder`. */
  className?: string;
  /** Shorthand icon name registered in `icons/registry.ts`. */
  icon?: FaLightIconName;
  spin?: boolean;
  style?: CSSProperties;
};

function resolveClassName(className: string | undefined, icon: FaLightIconName | undefined, spin: boolean | undefined): string {
  const tokens = new Set<string>();

  for (const token of (className || '').split(/\s+/)) {
    if (token) tokens.add(token);
  }

  if (icon) {
    for (const token of faLight(icon).split(/\s+/)) {
      tokens.add(token);
    }
  }

  if (spin) {
    tokens.add('fa-spin');
  }

  return Array.from(tokens).join(' ');
}

export function FaIcon({ className, icon, spin, ...props }: FaIconProps) {
  const resolved = resolveClassName(className, icon, spin);
  return <i className={resolved || undefined} aria-hidden="true" {...props} />;
}

/** Backward-compatible alias for simple text placeholders during migration. */
export function Icon({
  children,
  className,
  icon,
  spin,
  ...props
}: FaIconProps & { children?: string }) {
  if (children && !className && !icon) {
    return <span className="icon" aria-hidden="true" {...props}>{children}</span>;
  }

  return <FaIcon className={className} icon={icon} spin={spin} {...props} />;
}
