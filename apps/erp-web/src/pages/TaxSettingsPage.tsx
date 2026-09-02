import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardBody, DataTable, ErrorBanner, Select, SpinnerOverlay } from '@retail/ui-kit';
import { adminApi } from '../api/admin';
import { referenceApi } from '../api/reference';
import { describeError } from '../lib/apiClient';
import { usePermission } from '../hooks/usePermission';
import type { Tax, TaxPricingMode } from '../lib/apiTypes';

/**
 * Phase 20 — HOW TAX BEHAVES FOR THIS BUSINESS.
 *
 * TWO FIELDS, AND DELIBERATELY ONLY TWO, because `GET/PUT /settings/tax`
 * has exactly two: whether shelf prices already include tax, and which tax
 * applies to a product that names none of its own.
 *
 * THE RATES THEMSELVES ARE NOT EDITED HERE. Creating a tax and changing
 * its percentage is `POST/PATCH /taxes`, which already has a home on the
 * setup screen; duplicating it would give two places to change one number
 * and no answer about which one won. The table below is READ-ONLY and
 * exists so an administrator can see what they are choosing between.
 *
 * NOTHING IS CALCULATED HERE. The tax on a sale is resolved and computed
 * server-side inside `CreateSaleUseCase` — there is no endpoint anywhere
 * that applies a tax on a client's say-so — and each sale line snapshots
 * the rate that produced it, so changing a setting on this screen can
 * never reach a sale that already happened.
 *
 * AN INACTIVE TAX CANNOT BE THE DEFAULT. The server refuses it (422); the
 * picker offers only active taxes so the refusal is rarely reached, and
 * shows the current default even if it has since been deactivated rather
 * than silently appearing to have no default at all.
 */
export function TaxSettingsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const canManage = usePermission('tax.manage');

  const settings = useQuery({ queryKey: ['admin', 'tax-settings'], queryFn: () => adminApi.getTaxSettings() });
  const taxes = useQuery({ queryKey: ['taxes'], queryFn: () => referenceApi.listTaxes() });

  const [mode, setMode] = useState<TaxPricingMode | null>(null);
  const [defaultTaxId, setDefaultTaxId] = useState<string | null>(null);
  const [error, setError] = useState<{ title: string; message?: string } | null>(null);
  const [ok, setOk] = useState(false);

  const current = settings.data?.data;
  useEffect(() => {
    if (current) {
      setMode(current.taxPricingMode);
      setDefaultTaxId(current.defaultTaxId);
    }
  }, [current]);

  const save = useMutation({
    mutationFn: () =>
      adminApi.updateTaxSettings({
        taxPricingMode: mode ?? undefined,
        // An explicit `null` CLEARS the default; the contract draws that
        // distinction and the empty option means exactly that.
        defaultTaxId: defaultTaxId,
      }),
    onSuccess: async () => {
      setError(null);
      setOk(true);
      await queryClient.invalidateQueries({ queryKey: ['admin', 'tax-settings'] });
    },
    onError: (e) => {
      setOk(false);
      setError(describeError(e));
    },
  });

  if (settings.isLoading) return <SpinnerOverlay />;
  if (settings.isError) {
    return (
      <div className="mx-auto max-w-3xl p-4">
        <ErrorBanner {...describeError(settings.error)} />
      </div>
    );
  }
  if (!current || mode === null) return null;

  const taxList = taxes.data?.data ?? [];
  const activeTaxes = taxList.filter((tax) => tax.isActive);
  const selectedTax = taxList.find((tax) => tax.id === defaultTaxId);
  const dirty = mode !== current.taxPricingMode || defaultTaxId !== current.defaultTaxId;

  return (
    <div className="mx-auto max-w-3xl p-4">
      <h1 className="mb-1 text-lg font-bold text-neutral-900">{t('taxSettings.title')}</h1>
      <p className="mb-3 text-xs leading-snug text-neutral-500">{t('taxSettings.explainer')}</p>

      {error && <ErrorBanner title={error.title} message={error.message} />}
      {ok && (
        <div className="mb-3 rounded-lg border border-success-200 bg-success-50 p-3" data-testid="tax-settings-success">
          <p className="text-sm font-semibold text-success-700">{t('taxSettings.saved')}</p>
        </div>
      )}
      {!canManage && (
        <p className="mb-3 text-xs text-neutral-500" data-testid="tax-settings-readonly">
          {t('taxSettings.readOnly')}
        </p>
      )}

      <Card className="mb-3">
        <CardBody className="grid gap-3 p-4">
          <Select
            label={t('taxSettings.pricingMode')}
            value={mode}
            disabled={!canManage}
            onChange={(e) => {
              setOk(false);
              setMode(e.target.value as TaxPricingMode);
            }}
            hint={t(mode === 'INCLUSIVE' ? 'taxSettings.inclusiveHint' : 'taxSettings.exclusiveHint')}
            data-testid="tax-pricing-mode"
          >
            <option value="EXCLUSIVE">{t('taxSettings.exclusive')}</option>
            <option value="INCLUSIVE">{t('taxSettings.inclusive')}</option>
          </Select>

          <Select
            label={t('taxSettings.defaultTax')}
            value={defaultTaxId ?? ''}
            disabled={!canManage}
            onChange={(e) => {
              setOk(false);
              setDefaultTaxId(e.target.value === '' ? null : e.target.value);
            }}
            hint={t('taxSettings.defaultTaxHint')}
            data-testid="default-tax"
          >
            <option value="">{t('taxSettings.noDefaultTax')}</option>
            {activeTaxes.map((tax) => (
              <option key={tax.id} value={tax.id}>
                {tax.name} — {tax.ratePercent}%
              </option>
            ))}
            {/* Kept visible when the saved default has since been
                deactivated, so the screen never implies there is none. */}
            {selectedTax && !selectedTax.isActive && (
              <option value={selectedTax.id}>
                {selectedTax.name} — {selectedTax.ratePercent}% ({t('taxSettings.inactiveTax')})
              </option>
            )}
          </Select>
        </CardBody>
      </Card>

      {canManage && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Button
            loading={save.isPending}
            disabled={!dirty || save.isPending}
            onClick={() => save.mutate()}
            data-testid="save-tax-settings"
          >
            {t('common.save')}
          </Button>
          <Button
            variant="secondary"
            disabled={!dirty || save.isPending}
            onClick={() => {
              setOk(false);
              setMode(current.taxPricingMode);
              setDefaultTaxId(current.defaultTaxId);
            }}
          >
            {t('business.discard')}
          </Button>
        </div>
      )}

      <Card>
        <CardBody className="p-4">
          <h2 className="mb-1 text-sm font-bold text-neutral-900">{t('taxSettings.rates')}</h2>
          <p className="mb-2 text-xs leading-snug text-neutral-500">{t('taxSettings.ratesExplainer')}</p>
          {taxes.isError && <ErrorBanner {...describeError(taxes.error)} />}
          <DataTable
            data-testid="tax-rates-table"
            loading={taxes.isLoading}
            rows={taxList}
            rowKey={(tax) => tax.id}
            empty={t('taxSettings.noTaxes')}
            columns={[
              { key: 'name', header: t('taxSettings.taxName'), cell: (tax: Tax) => tax.name },
              {
                key: 'rate',
                header: t('taxSettings.rate'),
                align: 'end',
                className: 'numeric',
                cell: (tax) => `${tax.ratePercent}%`,
              },
              {
                key: 'default',
                header: t('taxSettings.isDefault'),
                cell: (tax) =>
                  tax.id === current.defaultTaxId ? <Badge tone="brand">{t('common.yes')}</Badge> : <span>—</span>,
              },
              {
                key: 'state',
                header: t('organisation.state'),
                cell: (tax) => (
                  <Badge tone={tax.isActive ? 'success' : 'neutral'}>
                    {t(tax.isActive ? 'organisation.active' : 'organisation.inactive')}
                  </Badge>
                ),
              },
            ]}
          />
        </CardBody>
      </Card>
    </div>
  );
}
