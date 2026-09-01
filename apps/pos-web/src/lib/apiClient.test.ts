import { describe, expect, it, beforeAll } from 'vitest';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from '../i18n/locales/en.json';
import ar from '../i18n/locales/ar.json';
import { ApiError, describeError } from './apiClient';

/**
 * Phase 12 (POS loose ends, B1) — the blocker was that an Arabic-first
 * till turned English at the moment something went wrong. These assert the
 * half that IS localized: the title and the guidance. The server's own
 * prose stays English by design (see `describeError`), and the last case
 * pins that down so the limitation cannot be forgotten.
 */
beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    resources: { ar: { translation: ar }, en: { translation: en } },
    lng: 'en',
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
  });
});

describe('describeError', () => {
  it('titles a known code in English', async () => {
    await i18n.changeLanguage('en');
    expect(describeError(new ApiError(403, { code: 'FORBIDDEN', message: '' })).title).toBe('Not permitted');
  });

  it('TITLES THE SAME CODE IN ARABIC — the blocker this fixes', async () => {
    await i18n.changeLanguage('ar');
    const described = describeError(new ApiError(403, { code: 'FORBIDDEN', message: '' }));
    expect(described.title).toBe('غير مسموح');
    expect(described.message).toContain('صلاحيات حسابك');
    await i18n.changeLanguage('en');
  });

  it('adds a localized explanation for the codes a till actually meets', () => {
    expect(describeError(new ApiError(409, { code: 'CONFLICT', message: '' })).message).toContain('Something changed');
    expect(describeError(new ApiError(422, { code: 'INSUFFICIENT_STOCK', message: '' })).message).toContain('not enough stock');
  });

  it('falls back to a localized generic title for a code it has never seen', async () => {
    expect(describeError(new ApiError(500, { code: 'TEAPOT_ON_FIRE', message: 'boom' })).title).toBe('Something went wrong');
    await i18n.changeLanguage('ar');
    expect(describeError(new ApiError(500, { code: 'TEAPOT_ON_FIRE', message: '' })).title).toBe('حدث خطأ ما');
    await i18n.changeLanguage('en');
  });

  it('KEEPS the server\'s specifics, which no error code could carry', () => {
    // The known limitation, asserted rather than hoped for: the server's
    // prose is still English, and it is still shown, because it names the
    // actual problem.
    const described = describeError(
      new ApiError(422, { code: 'VALIDATION_FAILED', message: 'This serial number was not sold on this sale line' }),
    );
    expect(described.message).toContain('not sold on this sale line');
  });

  it('shows no empty detail when neither a hint nor a server message exists', () => {
    expect(describeError(new ApiError(404, { code: 'NOT_FOUND', message: '' })).message).toBeUndefined();
  });

  it('handles a plain Error and a non-Error throw without crashing a screen', () => {
    expect(describeError(new Error('network down')).message).toBe('network down');
    expect(describeError('oops').title).toBe('Something went wrong');
  });
});
