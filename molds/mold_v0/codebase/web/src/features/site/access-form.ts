'use client';
/**
 * The early-access form in force (mold_v0-266, mold_v0-289; src/access-pages.ts): what staff saved in Admin › Access
 * requests, else the whole form the build declares, else the build's own. The public pages are given them by their server
 * component (./access-pages-live.ts); a form drawn without them (the portal's page for no account) asks the API once.
 * The defaults are the build's own form (src/access-request.ts defaultRequestForm), in the build's words.
 */
import { useEffect, useState } from 'react';
import { accessFields, accessForm } from '@/config/access-request.generated';
import { landing } from '@/config/landing.generated';
import { fill } from '@/lib/vocabulary';
import { defaultRequestForm, type AccessFormConfig, type FormWords, type RequestPageFormSpec } from '@/lib/access-request.generated';

export interface LiveAccessPages { request_form: AccessFormConfig | null }

/** The shell's words in the build's words, as the forms said them before mold_v0-266. */
export const formWords = (): FormWords => ({
  message: fill('What would you like to use {product} for?'),
  thanks: fill('Thank you. The {product} team will look at it'),
  first_step: fill('The {product} team looks at your request.')
});

/** The /request-access form as the build declares it. */
export const requestAccessDefaults = (): AccessFormConfig => accessForm ?? defaultRequestForm(accessFields, formWords(), null);
/** The landing's request page's form as the build declares it. */
export const requestPageDefaults = (form: RequestPageFormSpec = {}): AccessFormConfig => accessForm ?? defaultRequestForm(accessFields, formWords(), form);
/** Where the editor starts (and Reset to defaults returns to): the build's public form, its request page's when it has one. */
export const editorDefaults = (): AccessFormConfig => (landing?.request_page ? requestPageDefaults(landing.request_page.form ?? {}) : requestAccessDefaults());

let asked: Promise<LiveAccessPages | null> | null = null;
/** The pages in force, from the API (once per page load); null when it cannot be asked (the build's own then). */
export function fetchAccessPages(): Promise<LiveAccessPages | null> {
  asked ??= fetch('/api/access-pages', { cache: 'no-store', credentials: 'same-origin' })
    .then((r) => (r.ok ? (r.json() as Promise<LiveAccessPages>) : null))
    .catch(() => null);
  return asked;
}

/** The request form in force for a form drawn without it: undefined while asking, then the saved form or null. */
export function useLiveRequestForm(given: AccessFormConfig | null | undefined): AccessFormConfig | null | undefined {
  const [live, setLive] = useState<AccessFormConfig | null | undefined>(given);
  useEffect(() => {
    if (given !== undefined) return void setLive(given);
    let on = true;
    void fetchAccessPages().then((p) => { if (on) setLive(p?.request_form ?? null); });
    return () => { on = false; };
  }, [given]);
  return given !== undefined ? given : live;
}
