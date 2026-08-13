import { useCallback, useEffect, useMemo, useRef } from 'react';

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface DialogA11yOptions {
  enabled?: boolean;
  trapFocus?: boolean;
}

/**
 * Adds the keyboard and focus behavior expected from an application dialog.
 * The caller owns the dialog's open state; rendering the dialog enables it.
 */
export function useDialogA11y<T extends HTMLElement>(
  onClose: () => void,
  { enabled = true, trapFocus = true }: DialogA11yOptions = {}
) {
  const dialogRef = useRef<T | null>(null);
  const onCloseRef = useRef(onClose);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const restoreFocusCapturedRef = useRef(false);
  // `autoFocus` is applied during the commit before callback refs run. Keep a
  // render-time snapshot of the active element so the callback ref can still
  // capture the opener rather than the first input inside the dialog.
  const opener = useMemo(() => {
    if (!enabled || typeof document === 'undefined') {
      return null;
    }
    const active = document.activeElement;
    return active instanceof HTMLElement ? active : null;
  }, [enabled]);

  const captureDialogRef = useCallback(
    (node: T | null) => {
      dialogRef.current = node;
      // Use the pre-commit snapshot above because descendant autoFocus may
      // already have moved focus by the time this callback runs.
      if (node && enabled && !restoreFocusCapturedRef.current && typeof document !== 'undefined') {
        restoreFocusRef.current = opener;
        restoreFocusCapturedRef.current = true;
      }
    },
    [enabled, opener]
  );

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!enabled) {
      restoreFocusRef.current = null;
      restoreFocusCapturedRef.current = false;
      return;
    }

    const dialog = dialogRef.current;

    // Preserve a form field's native autoFocus. For content-only dialogs, move
    // focus to the first control so Tab never escapes into the page behind it.
    if (dialog) {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || !dialog.contains(active)) {
        dialog.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)?.focus();
      }
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (!trapFocus || event.key !== 'Tab') {
        return;
      }

      const currentDialog = dialogRef.current;
      if (!currentDialog) {
        return;
      }
      const focusable = Array.from(currentDialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (focusable.length === 0) {
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (!currentDialog.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      const previous = restoreFocusRef.current;
      if (previous && document.contains(previous)) {
        previous.focus();
      }
    };
  }, [enabled, trapFocus]);

  return captureDialogRef;
}
