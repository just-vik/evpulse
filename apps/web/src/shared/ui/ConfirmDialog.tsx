'use client';

import * as AlertDialog from '@radix-ui/react-alert-dialog';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
}

/**
 * Accessible confirmation dialog for side-effecting actions (vehicle
 * commands). Built on Radix AlertDialog: focus trap, Escape-to-close, and
 * focus restore on the trigger are handled by the primitive, not
 * hand-rolled here.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  onConfirm,
}: Props) {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=open]:fade-in data-[state=closed]:animate-out data-[state=closed]:fade-out" />
        <AlertDialog.Content
          className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2
            rounded-2xl border border-[hsl(var(--border)/0.9)] bg-[hsl(var(--background))] p-5 shadow-xl
            focus:outline-none data-[state=open]:animate-in data-[state=open]:fade-in data-[state=open]:zoom-in-95
            data-[state=closed]:animate-out data-[state=closed]:fade-out data-[state=closed]:zoom-out-95"
        >
          <AlertDialog.Title className="text-sm font-semibold text-foreground">{title}</AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-xs leading-relaxed text-muted-foreground">
            {description}
          </AlertDialog.Description>
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Cancel
              className="px-3 py-2 rounded-xl border border-[hsl(var(--border)/0.9)] text-xs text-foreground
                bg-transparent hover:bg-[hsl(var(--secondary)/0.6)] transition-all"
            >
              {cancelLabel}
            </AlertDialog.Cancel>
            <AlertDialog.Action
              onClick={onConfirm}
              className="px-3 py-2 rounded-xl border border-blue-400/50 text-xs font-semibold text-white
                bg-blue-500 hover:bg-blue-400 shadow-sm shadow-blue-500/25 transition-all"
            >
              {confirmLabel}
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
