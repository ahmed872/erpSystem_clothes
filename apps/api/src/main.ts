import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';
import { setupSwagger } from './common/openapi/setup-swagger';
import { assertEnvironmentIsUsable } from './common/config/validate-environment';

async function bootstrap() {
  // Phase 11: before anything is built or bound. A server missing a
  // signing secret used to start cleanly and fail on the first person who
  // tried to sign in - a deploy that looked successful and was unusable.
  assertEnvironmentIsUsable();

  const app = await NestFactory.create(AppModule, { cors: false });

  app.use(helmet());
  app.use(new RequestIdMiddleware().use.bind(new RequestIdMiddleware()));

  app.enableCors({
    origin: process.env.CORS_ORIGIN?.split(',') ?? false,
    credentials: true,
  });

  app.useGlobalFilters(new AllExceptionsFilter());
  app.setGlobalPrefix('api/v1');

  // Phase 10 (10I): the browsable contract, served alongside the API it
  // describes. Off by default OUTSIDE development: an unauthenticated map
  // of every endpoint is a gift to anyone probing a production host, and
  // `SWAGGER_ENABLED=true` is the deliberate act of publishing it.
  if (process.env.NODE_ENV !== 'production' || process.env.SWAGGER_ENABLED === 'true') {
    setupSwagger(app);
  }

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`API listening on :${port}`);
}

bootstrap();
