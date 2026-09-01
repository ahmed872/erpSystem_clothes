import { FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Button, Card, CardBody, ErrorBanner, Input } from '@retail/ui-kit';
import { authApi } from '../api/auth';
import { useAuthStore } from '../store/authStore';
import { bootstrapSession } from '../lib/bootstrap';
import { describeError } from '../lib/apiClient';
import { landingRoute } from '../lib/navigation';

export function LoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const setSession = useAuthStore((s) => s.setSession);

  const [businessSlug, setBusinessSlug] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ title: string; message?: string } | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const { data } = await authApi.login({ businessSlug: businessSlug.trim(), email: email.trim(), password });
      setSession({ businessSlug: businessSlug.trim(), accessToken: data.accessToken, refreshToken: data.refreshToken, user: data.user });
      await bootstrapSession();
      // WHERE A USER LANDS IS THEIR PERMISSIONS' ANSWER, not a constant.
      // An INVENTORY_MANAGER holds none of this milestone's three grants,
      // so sending everyone to /dashboard would drop them into a redirect
      // loop or a 403 and read as a broken product. `landingRoute` returns
      // the first destination they can actually reach, or null when this
      // account has no ERP surface at all - which /no-access states plainly.
      const target = landingRoute(useAuthStore.getState().permissions);
      navigate(target ?? '/no-access', { replace: true });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-50 px-4">
      <Card className="w-full max-w-sm">
        <CardBody className="flex flex-col gap-5 p-6">
          <div className="text-center">
            <h1 className="text-xl font-bold text-neutral-900">{t('login.title')}</h1>
            <p className="mt-1 text-sm text-neutral-500">{t('login.subtitle')}</p>
          </div>

          {error && <ErrorBanner title={error.title} message={error.message} />}

          <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
            <Input
              label={t('login.businessSlug')}
              name="businessSlug"
              autoComplete="organization"
              required
              value={businessSlug}
              onChange={(e) => setBusinessSlug(e.target.value)}
            />
            <Input
              label={t('login.email')}
              name="email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <Input
              label={t('login.password')}
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <Button type="submit" fullWidth loading={submitting} disabled={submitting}>
              {submitting ? t('login.submitting') : t('login.submit')}
            </Button>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}
