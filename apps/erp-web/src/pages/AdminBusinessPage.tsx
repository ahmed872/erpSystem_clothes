import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, CardBody, ErrorBanner, Input, Select, SpinnerOverlay } from '@retail/ui-kit';
import { adminApi } from '../api/admin';
import { referenceApi } from '../api/reference';
import { describeError } from '../lib/apiClient';
import { usePermission } from '../hooks/usePermission';
import type { BusinessInput, BusinessProfile } from '../lib/apiTypes';

/**
 * Phase 20 — BUSINESS PROFILE.
 *
 * EXACTLY THE 14 FIELDS `updateBusinessSchema` ACCEPTS, and no others.
 * `slug` and `status` are shown read-only because the schema does not
 * take them; a box for either would appear to save something the backend
 * silently drops.
 *
 * TIMEZONE IS SAID OUT LOUD. The backend accepts any string of 1–64
 * characters — `Not/AZone` returns 200 — and every report window is
 * resolved in whatever is stored there. So the field offers the IANA
 * zones the browser itself knows, and the hint states plainly that the
 * server does not validate it. Inventing a client-side validation and
 * calling the system safe would be worse: the next caller to use the API
 * directly would still store nonsense.
 *
 * TAX SETTINGS ARE PHASE 14's, REUSED NOT REBUILT. `GET`/`PUT
 * /settings/tax` already exist and already have a screen behind
 * `/setup`; this page reads them for context and links there rather than
 * duplicating the editor.
 *
 * THE KEY/VALUE `/settings` STORE IS DELIBERATELY NOT EXPOSED. It is
 * empty by default, has no catalog of valid keys, and accepts anything —
 * an arbitrary configuration editor over it would be a way to write
 * meaningless rows, not a feature.
 */
const EDITABLE_FIELDS: (keyof BusinessInput)[] = [
  'name',
  'legalName',
  'taxNumber',
  'registrationNumber',
  'phone',
  'email',
  'addressLine',
  'city',
  'country',
  'logoUrl',
  'receiptHeader',
  'receiptFooter',
];

/** The zones the running browser knows about, so the picker offers real
 *  values even though the server validates none of them. */
function knownTimezones(): string[] {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] };
  try {
    return intl.supportedValuesOf?.('timeZone') ?? [];
  } catch {
    return [];
  }
}

export function AdminBusinessPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const canEdit = usePermission('business.edit');
  const canViewTax = usePermission('tax.view');

  const business = useQuery({ queryKey: ['admin-business'], queryFn: () => adminApi.getBusiness() });
  const taxes = useQuery({ queryKey: ['taxes'], queryFn: () => referenceApi.listTaxes(), enabled: canViewTax });

  const [form, setForm] = useState<Record<string, string>>({});
  const [currency, setCurrency] = useState('');
  const [timezone, setTimezone] = useState('');
  const [error, setError] = useState<{ title: string; message?: string } | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  useEffect(() => {
    const b = business.data?.data;
    if (!b) return;
    const next: Record<string, string> = {};
    for (const field of EDITABLE_FIELDS) next[field] = (b[field as keyof BusinessProfile] as string | null) ?? '';
    setForm(next);
    setCurrency(b.currency);
    setTimezone(b.timezone);
  }, [business.data]);

  const save = useMutation({
    mutationFn: () => {
      const body: BusinessInput = { currency: currency.trim().toUpperCase(), timezone: timezone.trim() };
      for (const field of EDITABLE_FIELDS) {
        const value = (form[field] ?? '').trim();
        // Every profile field is optional; an empty one is omitted
        // rather than sent as '' — the schema's `profileText` would
        // reject a blank email outright.
        if (value) (body as Record<string, string>)[field] = value;
      }
      return adminApi.updateBusiness(body);
    },
    onSuccess: async () => {
      setError(null);
      setOk(t('admin.business.saved'));
      await queryClient.invalidateQueries({ queryKey: ['admin-business'] });
    },
    onError: (e) => {
      setOk(null);
      setError(describeError(e));
    },
  });

  if (business.isLoading) return <SpinnerOverlay />;
  if (business.isError) {
    return (
      <div className="mx-auto max-w-4xl p-4">
        <ErrorBanner {...describeError(business.error)} />
      </div>
    );
  }
  const b = business.data!.data;
  const zones = knownTimezones();
  const defaultTax = taxes.data?.data.find((x) => x.id === b.defaultTaxId);

  return (
    <div className="mx-auto max-w-4xl p-4">
      <h1 className="mb-1 text-lg font-bold text-neutral-900">{t('admin.business.title')}</h1>
      <p className="mb-3 text-xs leading-snug text-neutral-500">{t('admin.business.explainer')}</p>

      {error && <ErrorBanner title={error.title} message={error.message} />}
      {ok && (
        <div className="mb-3 rounded-lg border border-success-200 bg-success-50 p-3" data-testid="business-success">
          <p className="text-sm font-semibold text-success-700">{ok}</p>
        </div>
      )}

      {/* Read-only identity: the schema accepts neither. */}
      <Card className="mb-4">
        <CardBody className="grid grid-cols-1 gap-x-6 gap-y-2 p-4 sm:grid-cols-2">
          <ReadOnly label={t('admin.business.slug')} value={b.slug} testId="business-slug" />
          <ReadOnly label={t('admin.business.status')} value={b.status} />
          <p className="text-xs leading-snug text-neutral-500 sm:col-span-2">{t('admin.business.readOnlyHint')}</p>
        </CardBody>
      </Card>

      <Card className="mb-4">
        <CardBody className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2" data-testid="business-form">
          <Input label={t('admin.business.name')} value={form.name ?? ''} onChange={(e) => setForm({ ...form, name: e.target.value })} data-testid="business-name" disabled={!canEdit} />
          <Input label={t('admin.business.legalName')} value={form.legalName ?? ''} onChange={(e) => setForm({ ...form, legalName: e.target.value })} disabled={!canEdit} />
          <Input label={t('admin.business.taxNumber')} value={form.taxNumber ?? ''} onChange={(e) => setForm({ ...form, taxNumber: e.target.value })} data-testid="business-tax-number" disabled={!canEdit} />
          <Input label={t('admin.business.registrationNumber')} value={form.registrationNumber ?? ''} onChange={(e) => setForm({ ...form, registrationNumber: e.target.value })} disabled={!canEdit} />
          <Input label={t('admin.business.phone')} value={form.phone ?? ''} onChange={(e) => setForm({ ...form, phone: e.target.value })} disabled={!canEdit} />
          <Input label={t('admin.business.email')} type="email" value={form.email ?? ''} onChange={(e) => setForm({ ...form, email: e.target.value })} disabled={!canEdit} />
          <Input label={t('admin.business.addressLine')} value={form.addressLine ?? ''} onChange={(e) => setForm({ ...form, addressLine: e.target.value })} disabled={!canEdit} />
          <Input label={t('admin.business.city')} value={form.city ?? ''} onChange={(e) => setForm({ ...form, city: e.target.value })} disabled={!canEdit} />
          <Input label={t('admin.business.country')} value={form.country ?? ''} onChange={(e) => setForm({ ...form, country: e.target.value })} disabled={!canEdit} />
          <Input label={t('admin.business.currency')} value={currency} onChange={(e) => setCurrency(e.target.value)} data-testid="business-currency" disabled={!canEdit} />

          {zones.length > 0 ? (
            <Select label={t('admin.business.timezone')} value={timezone} onChange={(e) => setTimezone(e.target.value)} data-testid="business-timezone" disabled={!canEdit}>
              {/* The stored value may not be a real zone — the server
                  never checked — so it is offered first regardless. */}
              {!zones.includes(timezone) && <option value={timezone}>{timezone}</option>}
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </Select>
          ) : (
            <Input label={t('admin.business.timezone')} value={timezone} onChange={(e) => setTimezone(e.target.value)} data-testid="business-timezone" disabled={!canEdit} />
          )}

          <div className="sm:col-span-2">
            <p className="text-xs leading-snug text-warning-800" data-testid="timezone-hint">
              {t('admin.business.timezoneHint')}
            </p>
          </div>

          <Input label={t('admin.business.logoUrl')} value={form.logoUrl ?? ''} onChange={(e) => setForm({ ...form, logoUrl: e.target.value })} disabled={!canEdit} />
          <Input label={t('admin.business.receiptHeader')} value={form.receiptHeader ?? ''} onChange={(e) => setForm({ ...form, receiptHeader: e.target.value })} disabled={!canEdit} />
          <Input label={t('admin.business.receiptFooter')} value={form.receiptFooter ?? ''} onChange={(e) => setForm({ ...form, receiptFooter: e.target.value })} disabled={!canEdit} />

          {canEdit && (
            <div className="sm:col-span-2">
              <Button onClick={() => save.mutate()} disabled={save.isPending} data-testid="save-business">
                {t('common.save')}
              </Button>
            </div>
          )}
        </CardBody>
      </Card>

      {/* Phase 14's tax settings, reused rather than rebuilt. */}
      {canViewTax && (
        <Card>
          <CardBody className="p-4" data-testid="tax-summary">
            <h2 className="mb-2 text-sm font-bold text-neutral-900">{t('admin.business.tax')}</h2>
            <ReadOnly label={t('admin.business.taxPricingMode')} value={b.taxPricingMode} testId="tax-pricing-mode" />
            <ReadOnly label={t('admin.business.defaultTax')} value={defaultTax?.name ?? t('admin.business.noDefaultTax')} testId="default-tax" />
            <p className="mt-2 text-xs leading-snug text-neutral-500">{t('admin.business.taxHint')}</p>
          </CardBody>
        </Card>
      )}
    </div>
  );
}

function ReadOnly({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-neutral-100 py-1 last:border-0">
      <span className="text-xs text-neutral-500">{label}</span>
      <span className="numeric text-sm text-neutral-900" data-testid={testId}>
        {value}
      </span>
    </div>
  );
}
