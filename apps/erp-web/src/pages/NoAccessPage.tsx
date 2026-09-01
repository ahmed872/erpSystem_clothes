import { useTranslation } from 'react-i18next';
import { Card, CardBody } from '@retail/ui-kit';

/**
 * Phase 13 — an account with no ERP surface at all.
 *
 * An INVENTORY_MANAGER holds none of this milestone's three grants. Landing
 * them on an empty shell, or bouncing them between guarded routes, would
 * read as a broken product; this says plainly that the back office has
 * nothing for them YET — later ERP milestones add the modules they do hold.
 */
export function NoAccessPage() {
  const { t } = useTranslation();
  return (
    <div className="mx-auto max-w-md p-8 text-center">
      <Card>
        <CardBody className="p-6">
          <p className="text-sm font-semibold text-neutral-900" data-testid="no-access">
            {t('noAccess.title')}
          </p>
          <p className="mt-2 text-sm leading-snug text-neutral-600">{t('noAccess.body')}</p>
        </CardBody>
      </Card>
    </div>
  );
}
