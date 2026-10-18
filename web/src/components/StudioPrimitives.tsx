import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Link } from 'react-router';

export type IconName =
  | 'play'
  | 'pause'
  | 'plus'
  | 'arrow'
  | 'back'
  | 'external'
  | 'undo'
  | 'redo'
  | 'download'
  | 'close'
  | 'check'
  | 'video'
  | 'spark'
  | 'alert'
  | 'clock';
export interface IconProps {
  name: IconName;
  size?: number;
}
const paths: Record<IconName, string> = {
  play: 'm8 5 11 7-11 7Z',
  pause: 'M8 5v14M16 5v14',
  plus: 'M12 5v14M5 12h14',
  arrow: 'M5 12h14m-6-6 6 6-6 6',
  back: 'M19 12H5m6-6-6 6 6 6',
  external: 'M14 4h6v6m0-6L10 14M10 4H4v16h16v-6',
  undo: 'M9 5 4 10l5 5M4 10h10a6 6 0 0 1 0 12',
  redo: 'm15 5 5 5-5 5m5-5H10a6 6 0 0 0 0 12',
  download: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
  close: 'm6 6 12 12M6 18 18 6',
  check: 'm5 12 4 4L19 6',
  video: 'M3 5h13v14H3ZM16 10l5-3v10l-5-3',
  spark: 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z',
  alert: 'm12 3 10 18H2Zm0 6v5m0 3v1',
  clock: 'M12 8v4l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z',
};
export function Icon({ name, size = 18 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  pending?: boolean;
  icon?: IconName;
}
export function Button({
  variant = 'secondary',
  pending = false,
  icon,
  children,
  disabled,
  className = '',
  ...props
}: ButtonProps) {
  return (
    <button
      type="button"
      {...props}
      className={`button button--${variant} ${className}`}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
    >
      {pending ? (
        <span className="spinner" aria-hidden="true" />
      ) : icon ? (
        <Icon name={icon} />
      ) : null}
      {children}
    </button>
  );
}
export interface StatusBadgeProps {
  status: string;
  label?: string;
}
const labels: Record<string, string> = {
  awaiting_speaker: 'Choose speaker',
  none: 'Not analyzed',
  running: 'Analyzing',
  done: 'Framing ready',
  youtube_shorts: 'YouTube Shorts',
  scheduled: 'Scheduled',
  cancelled: 'Schedule cancelled',
};
export function StatusBadge({ status, label }: StatusBadgeProps) {
  return (
    <span className={`status status--${status}`}>
      <span className="status-dot" />
      {label ?? labels[status] ?? status.replaceAll('_', ' ')}
    </span>
  );
}

export interface ScheduleCancelButtonProps {
  description: string;
  pending?: boolean;
  disabled?: boolean;
  onConfirm: () => void;
}
export function ScheduleCancelButton({ description, pending = false, disabled = false, onConfirm }: ScheduleCancelButtonProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const keepButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) keepButton.current?.focus({ preventScroll: true });
  }, [open]);
  useEffect(() => {
    if (pending || disabled) setOpen(false);
  }, [pending, disabled]);
  function close() {
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  }
  return (
    <div className="schedule-cancel">
      <button
        ref={trigger}
        type="button"
        className="button button--ghost schedule-cancel-trigger"
        disabled={pending || disabled}
        aria-busy={pending || undefined}
        aria-label={`${pending ? 'Cancelling' : 'Cancel'} ${description}`}
        aria-expanded={open}
        aria-controls={open ? `${id}-confirmation` : undefined}
        onClick={() => setOpen(!open)}
      >
        {pending && <span className="spinner" aria-hidden="true" />}
        {pending ? 'Cancelling…' : 'Cancel'}
      </button>
      {open && (
        <div
          id={`${id}-confirmation`}
          className="schedule-cancel-confirmation"
          role="group"
          aria-labelledby={`${id}-question`}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              close();
            }
          }}
        >
          <strong id={`${id}-question`}>Cancel this scheduled post?</strong>
          <p>{description} won’t be published.</p>
          <div className="button-group">
            <button ref={keepButton} type="button" className="button button--secondary" onClick={close}>Keep post</button>
            <Button variant="danger" onClick={() => {
              setOpen(false);
              onConfirm();
            }}>Cancel post</Button>
          </div>
        </div>
      )}
    </div>
  );
}
export interface ApiErrorProps {
  message?: string | null;
  onDismiss?: () => void;
  title?: string;
}
export function ApiError({ message, onDismiss, title = 'Something went wrong' }: ApiErrorProps) {
  if (!message) return null;
  return (
    <div className="api-error" role="alert">
      <Icon name="alert" />
      <div>
        <strong>{title}</strong>
        <p>{message}</p>
      </div>
      {onDismiss && (
        <Button variant="ghost" aria-label="Dismiss error" onClick={onDismiss} icon="close" />
      )}
    </div>
  );
}
export interface EmptyStateProps {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}
export function EmptyState({ title, children, action }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <Icon name="video" size={25} />
      </div>
      <h2>{title}</h2>
      <p>{children}</p>
      {action}
    </div>
  );
}
export interface StudioShellProps {
  children: ReactNode;
  breadcrumb?: ReactNode;
}
export function StudioShell({ children, breadcrumb }: StudioShellProps) {
  return (
    <div className="studio-shell">
      <header className="shell-header">
        <Link className="brand" to="/">
          <span className="brand-mark">
            <Icon name="video" size={19} />
          </span>
          Shorts<span className="brand-sub">STUDIO</span>
        </Link>
        <div className="shell-breadcrumb">{breadcrumb}</div>
        <span className="local-indicator">
          <span />
          Local workspace
        </span>
      </header>
      <main className="page-content">{children}</main>
    </div>
  );
}
export interface ToggleProps {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}
export function Toggle({ label, description, checked, onChange, disabled }: ToggleProps) {
  return (
    <label className="toggle-row">
      <span>
        <span className="control-label">{label}</span>
        {description && <span className="control-description">{description}</span>}
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        disabled={disabled}
      />
      <span className="switch-track" aria-hidden="true" />
    </label>
  );
}
export interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  disabled?: boolean;
  onChange: (value: number) => void;
}
export function Slider({ label, value, min, max, step, display, disabled, onChange }: SliderProps) {
  return (
    <label className={`slider-field ${disabled ? 'is-disabled' : ''}`}>
      <span className="field-line">
        <span>{label}</span>
        <output>{display}</output>
      </span>
      <input
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}
export function formatTime(seconds: number): string {
  const safe = Math.max(0, seconds);
  return `${Math.floor(safe / 60)}:${Math.floor(safe % 60)
    .toString()
    .padStart(2, '0')}`;
}
export function relativeTime(value: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - new Date(value).getTime()) / 60000));
  if (!Number.isFinite(minutes)) return 'Recently';
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}
