"use client";

import { X, type LucideIcon } from "lucide-react";
import { useEffect, type ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export function cn(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

export function Button({
  children,
  variant = "secondary",
  icon: Icon,
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  icon?: LucideIcon;
}) {
  return (
    <button className={cn("button", `button-${variant}`, className)} {...props}>
      {Icon ? <Icon size={16} aria-hidden="true" /> : null}
      <span>{children}</span>
    </button>
  );
}

export function StatusBadge({ status, children }: { status: string; children: ReactNode }) {
  return (
    <span className={cn("status-badge", `status-${status}`)}>
      <span className="status-dot" aria-hidden="true" />
      {children}
    </span>
  );
}

export function Metric({ label, value, note, icon: Icon }: { label: string; value: string; note: string; icon: LucideIcon }) {
  return (
    <div className="metric-cell">
      <div className="metric-icon" aria-hidden="true"><Icon size={17} /></div>
      <div>
        <p className="metric-label">{label}</p>
        <p className="metric-value">{value}</p>
        <p className="metric-note">{note}</p>
      </div>
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  compact = false,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={cn("empty-state", compact && "empty-state-compact")}>
      <span className="empty-state-icon" aria-hidden="true"><Icon size={24} /></span>
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </div>
  );
}

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  width = "normal",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  width?: "normal" | "wide";
}) {
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onOpenChange, open]);

  if (!open) return null;
  return (
    <div className="dialog-layer">
        <button className="dialog-overlay" onClick={() => onOpenChange(false)} aria-label="关闭弹窗遮罩" />
        <div className={cn("dialog-content", width === "wide" && "dialog-wide")} role="dialog" aria-modal="true" aria-labelledby="dialog-title" aria-describedby={description ? "dialog-description" : undefined}>
          <div className="dialog-heading">
            <div>
              <h2 id="dialog-title">{title}</h2>
              {description ? <p id="dialog-description">{description}</p> : null}
            </div>
            <button className="icon-button" aria-label="关闭弹窗" onClick={() => onOpenChange(false)}><X size={18} /></button>
          </div>
          {children}
        </div>
    </div>
  );
}
