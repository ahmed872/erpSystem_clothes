import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, CardBody, ErrorBanner, Input, SpinnerOverlay } from '@retail/ui-kit';
import { adminApi } from '../api/admin';
import { describeError } from '../lib/apiClient';
import { businessFormFrom, businessPatch, hasChanges, nextBusinessForm, type BusinessForm } from '../lib/admin';
import { usePermission } from '../hooks/usePermission';

/**
 * Phase 20 — THE BUSINESS'S OWN IDENTITY, as it appears on a receipt.
 *
 * THIS IS NOT A GENERIC SETTINGS EDITOR. `GET/PUT /settings` is a
 * key/value store whose keys are written by whichever module owns them;
 * exposing it as a free-text JSON editor would let an administrator break
 * tax mode, invoice numbering or the accounting mapping with a typo and
 * no validation anywhere. This screen edits `GET/PATCH /business` — a
 * fixed, named set of fields with a schema behind each — and nothing else.
 *
 * NO FORMAT IS VALIDATED HERE, and none should be. Every profile field is
 * free text server-side because the product has not been told which
 * country's invoicing regime applies; a tax-number pattern invented in the
 * browser would break the first business whose country works differently.
 *
 * CLEARING A FIELD IS A REAL ACT. The contract distinguishes `null`
 * (clear this) from an omitted key (leave it alone), and `businessPatch`
 * preserves that: only what actually changed is sent, and an emptied field
 * goes as `null` rather than `''`.
 */
export function BusinessSettingsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const canEdit = usePermission('business.edit');

  const business = useQuery({ queryKey: ['admin', 'business'], queryFn: () => adminApi.getBusiness() });
  const profile = business.data?.data;

  const [form, setForm] = useState<BusinessForm | null>(null);
  /** Has the operator changed anything since this form was seeded. */
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<{ title: string; message?: string } | null>(null);
  const [ok, setOk] = useState(false);

  // A fresh copy from the server seeds the form, and re-seeds it only while
  // the operator has not touched it. Saving invalidates this query, so its
  // response arrives a moment after the save — and must not wipe whatever
  // they started typing in the meantime. See `nextBusinessForm`.
  useEffect(() => {
    if (!profile) return;
    setForm((current) => nextBusinessForm(profile, current, touched));
  }, [profile, touched]);

  const save = useMutation({
    mutationFn: () => adminApi.updateBusiness(businessPatch(profile!, form!)),
    onSuccess: async () => {
      setError(null);
      setOk(true);
      await queryClient.invalidateQueries({ queryKey: ['admin', 'business'] });
    },
    onError: (e) => {
      setOk(false);
      setError(describeError(e));
    },
  });

  if (business.isLoading) return <SpinnerOverlay />;
  if (business.isError) {
    return (
      <div className="mx-auto max-w-3xl p-4">
        <ErrorBanner {...describeError(business.error)} />
      </div>
    );
  }
  if (!profile || !form) return null;

  const patch = businessPatch(profile, form);
  const dirty = hasChanges(patch);
  const field = (key: keyof BusinessForm) => ({
    value: form[key],
    disabled: !canEdit,
    onChange: (e: { target: { value: string } }) => {
      setOk(false);
      setTouched(true);
      setForm({ ...form, [key]: e.target.value });
    },
    'data-testid': `business-${key}`,
  });

  return (
    <div className="mx-auto max-w-3xl p-4">
      <h1 className="mb-1 text-lg font-bold text-neutral-900">{t('business.title')}</h1>
      <p className="mb-3 text-xs leading-snug text-neutral-500">{t('business.explainer')}</p>

      {error && <ErrorBanner title={error.title} message={error.message} />}
      {ok && (
        <div className="mb-3 rounded-lg border border-success-200 bg-success-50 p-3" data-testid="business-success">
          <p className="text-sm font-semibold text-success-700">{t('business.saved')}</p>
        </div>
      )}
      {!canEdit && (
        <p className="mb-3 text-xs text-neutral-500" data-testid="business-readonly">
          {t('business.readOnly')}
        </p>
      )}

      <Card className="mb-3">
        <CardBody className="grid gap-3 p-4 sm:grid-cols-2">
          <h2 className="text-sm font-bold text-neutral-900 sm:col-span-2">{t('business.identity')}</h2>
          <Input label={t('business.name')} {...field('name')} />
          {/* The slug is the tenant's address and is not editable anywhere
              in the contract — shown so an administrator can read it. */}
          <Input label={t('business.slug')} value={profile.slug} disabled data-testid="business-slug" />
          <Input label={t('business.legalName')} {...field('legalName')} />
          <Input label={t('business.taxNumber')} {...field('taxNumber')} />
          <Input label={t('business.registrationNumber')} {...field('registrationNumber')} />
        </CardBody>
      </Card>

      <Card className="mb-3">
        <CardBody className="grid gap-3 p-4 sm:grid-cols-2">
          <h2 className="text-sm font-bold text-neutral-900 sm:col-span-2">{t('business.contact')}</h2>
          <Input label={t('business.phone')} {...field('phone')} />
          <Input label={t('business.email')} type="email" {...field('email')} />
          <Input label={t('business.addressLine')} {...field('addressLine')} />
          <Input label={t('business.city')} {...field('city')} />
          <Input label={t('business.country')} {...field('country')} />
        </CardBody>
      </Card>

      <Card className="mb-3">
        <CardBody className="grid gap-3 p-4 sm:grid-cols-2">
          <h2 className="text-sm font-bold text-neutral-900 sm:col-span-2">{t('business.locale')}</h2>
          <Input label={t('business.currency')} hint={t('business.currencyHint')} {...field('currency')} />
          <Input label={t('business.timezone')} hint={t('business.timezoneHint')} {...field('timezone')} />
        </CardBody>
      </Card>

      <Card className="mb-3">
        <CardBody className="grid gap-3 p-4">
          <h2 className="text-sm font-bold text-neutral-900">{t('business.receipt')}</h2>
          <p className="text-xs leading-snug text-neutral-500">{t('business.receiptExplainer')}</p>
          <Input label={t('business.logoUrl')} {...field('logoUrl')} />
          <Input label={t('business.receiptHeader')} {...field('receiptHeader')} />
          <Input label={t('business.receiptFooter')} {...field('receiptFooter')} />
        </CardBody>
      </Card>

      {canEdit && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            loading={save.isPending}
            disabled={!dirty || save.isPending}
            onClick={() => save.mutate()}
            data-testid="save-business"
          >
            {t('common.save')}
          </Button>
          <Button
            variant="secondary"
            disabled={!dirty || save.isPending}
            onClick={() => {
              setOk(false);
              setTouched(false);
              setForm(businessFormFrom(profile));
            }}
            data-testid="reset-business"
          >
            {t('business.discard')}
          </Button>
          {dirty && (
            <p className="text-xs text-neutral-500" data-testid="business-dirty">
              {t('business.unsaved', { count: Object.keys(patch).length })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
