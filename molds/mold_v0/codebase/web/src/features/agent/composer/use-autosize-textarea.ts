'use client';
import { useLayoutEffect, type RefObject } from 'react';

/**
 * Grow a controlled textarea with its content, up to a cap (mold_v0-290, ported from the reference product's composer). Keyed
 * on the value, not on keystrokes: dictation and a preset first message change it without a change event on the element.
 */
export function useAutosizeTextarea(ref: RefObject<HTMLTextAreaElement | null>, value: string, maxHeight: number) {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    // Collapse before measuring: scrollHeight only reports the content while the box is not already stretched around it.
    element.style.height = 'auto';
    const contentHeight = element.scrollHeight;
    element.style.height = `${Math.min(contentHeight, maxHeight)}px`;
    element.style.overflowY = contentHeight > maxHeight ? 'auto' : 'hidden';
  }, [ref, value, maxHeight]);
}
