import { FormEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Button, Card, CardBody, ErrorBanner, Input, Select, SpinnerOverlay } from '@retail/ui-kit';
import { shiftsApi } from '../api/shifts';
import { cashRegistersApi } from '../api/cashRegisters';
import { useShiftStore } from '../store/shiftStore';
import { ApiError, describeError } from '../lib/apiClient';

export function ShiftSetupPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const setActiveShift = useShiftStore((s) => s.setActiveShift);

  const warehousesQuery = useQuery({
    queryKey: ['pos-warehouses'],
    queryFn: () => shiftsApi.availableWarehouses(),
    retry: false,
  });

  const warehouses = warehousesQuery.data?.data ?? [];
  const [warehouseId, setWarehouseId] = useState('');
  const [cashRegisterId, setCashRegisterId] = useState('');
  const [openingFloat, setOpeningFloat] = useState('0');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ title: string; message?: string } | null>(null);

  useEffect(() => {
    const first = warehousesQuery.data?.data[0];
    if (first && !warehouseId) setWarehouseId(first.id);
  }, [warehousesQuery.data, warehouseId]);

  const selectedWarehouse = warehouses.find((w) => w.id === warehouseId);

  const registersQuery = useQuery({
    queryKey: ['cash-registers', selectedWarehouse?.branchId],
    queryFn: () => cashRegistersApi.list(selectedWarehouse!.branchId),
    enabled: Boolean(selectedWarehouse),
  });
  const registers = (registersQuery.data?.data ?? []).filter((r) => r.isActive);

  useEffect(() => {
    if (registers.length > 0 && !registers.some((r) => r.id === cashRegisterId)) setCashRegisterId(registers[0].id);
  }, [registers, cashRegisterId]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const { data } = await shiftsApi.open({
        warehouseId,
        cashRegisterId,
        openingFloat: Number(openingFloat) || 0,
      });
      setActiveShift(data);
      navigate('/pos', { replace: true });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  const noWarehouseAuthorized = warehousesQuery.isError && warehousesQuery.error instanceof ApiError && warehousesQuery.error.status === 422;

  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-50 px-4">
      <Card className="w-full max-w-md">
        <CardBody className="flex flex-col gap-5 p-6">
          <h1 className="text-xl font-bold text-neutral-900">{t('shiftSetup.title')}</h1>

          {warehousesQuery.isLoading && <SpinnerOverlay />}

          {noWarehouseAuthorized && <ErrorBanner title={t('shiftSetup.noWarehouse')} />}

          {warehousesQuery.isError && !noWarehouseAuthorized && (
            <ErrorBanner title={describeError(warehousesQuery.error).title} message={describeError(warehousesQuery.error).message} />
          )}

          {warehouses.length > 0 && (
            <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
              <p className="text-sm text-neutral-500">{t('shiftSetup.chooseWarehouse')}</p>

              <Select label={t('shiftSetup.warehouse')} value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.branchName} — {w.name}
                  </option>
                ))}
              </Select>

              {/* Every ACTIVE register in the branch is offered. Whether one
                  is already taken is not asked here and must not be guessed:
                  one-open-shift-per-register is enforced by a partial unique
                  index, so the server is the only thing that can answer it
                  without racing. A busy till returns 409 on submit and the
                  banner below says so in the server's own words. */}
              <Select
                label={t('shiftSetup.register')}
                value={cashRegisterId}
                onChange={(e) => setCashRegisterId(e.target.value)}
                disabled={registers.length === 0}
                data-testid="register-select"
              >
                {registers.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} ({r.code})
                  </option>
                ))}
              </Select>

              {registers.length === 0 && !registersQuery.isLoading && (
                <ErrorBanner title={t('shiftSetup.noRegister')} />
              )}

              <Input
                label={t('shiftSetup.openingFloat')}
                hint={t('shiftSetup.openingFloatHint')}
                type="number"
                min={0}
                step="0.01"
                className="numeric"
                value={openingFloat}
                onChange={(e) => setOpeningFloat(e.target.value)}
                data-testid="opening-float"
              />

              {error && <ErrorBanner title={error.title} message={error.message} />}

              <Button type="submit" fullWidth loading={submitting} disabled={submitting || !cashRegisterId} data-testid="open-shift">
                {t('shiftSetup.submit')}
              </Button>

              {/* Said at opening, not sprung at closing. */}
              <p className="text-xs leading-snug text-neutral-500">{t('shiftSetup.blindCloseWarning')}</p>
            </form>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
