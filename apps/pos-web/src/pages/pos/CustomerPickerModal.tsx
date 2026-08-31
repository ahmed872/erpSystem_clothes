import { FormEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Button, EmptyState, ErrorBanner, Input, Modal, Spinner } from '@retail/ui-kit';
import { customersApi } from '../../api/customers';
import { describeError } from '../../lib/apiClient';
import type { Customer } from '../../lib/apiTypes';

export function CustomerPickerModal({
  open,
  onClose,
  onSelect,
}: {
  open: boolean;
  onClose: () => void;
  onSelect: (customer: Customer | null) => void;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [error, setError] = useState<{ title: string; message?: string } | null>(null);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(id);
  }, [search]);

  const query = useQuery({
    queryKey: ['customers', debounced],
    queryFn: () => customersApi.search(debounced),
    enabled: open && debounced.length > 0,
  });

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const { data } = await customersApi.create({ name: newName.trim(), phone: newPhone.trim() || undefined });
      onSelect(data);
      setCreating(false);
      setNewName('');
      setNewPhone('');
    } catch (err) {
      setError(describeError(err));
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={t('pos.customer')} size="md">
      <div className="flex flex-col gap-3">
        <Button variant="secondary" size="sm" onClick={() => onSelect(null)}>
          {t('pos.walkIn')}
        </Button>

        {!creating ? (
          <>
            <Input placeholder={t('common.search')} value={search} onChange={(e) => setSearch(e.target.value)} autoFocus />
            <div className="max-h-64 overflow-y-auto rounded-lg border border-neutral-200">
              {query.isFetching && (
                <div className="flex justify-center p-4">
                  <Spinner />
                </div>
              )}
              {!query.isFetching && debounced && (query.data?.data.length ?? 0) === 0 && (
                <EmptyState title={t('common.noResults')} />
              )}
              {query.data?.data.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => onSelect(c)}
                  className="flex w-full flex-col items-start border-b border-neutral-100 px-3 py-2 text-start last:border-b-0 hover:bg-neutral-50"
                >
                  <span className="text-sm font-medium text-neutral-900">{c.name}</span>
                  {c.phone && <span className="text-xs text-neutral-500">{c.phone}</span>}
                </button>
              ))}
            </div>
            <Button variant="ghost" size="sm" onClick={() => setCreating(true)}>
              + {t('pos.addCustomer')}
            </Button>
          </>
        ) : (
          <form className="flex flex-col gap-3" onSubmit={handleCreate}>
            {error && <ErrorBanner title={error.title} message={error.message} />}
            <Input label={t('pos.customerName')} required value={newName} onChange={(e) => setNewName(e.target.value)} />
            <Input label={t('pos.customerPhone')} value={newPhone} onChange={(e) => setNewPhone(e.target.value)} />
            <div className="flex gap-2">
              <Button type="submit" size="sm">
                {t('common.save')}
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setCreating(false)}>
                {t('common.cancel')}
              </Button>
            </div>
          </form>
        )}
      </div>
    </Modal>
  );
}
