import { ValidationPipe, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.setGlobalPrefix("api");
  app.enableShutdownHooks();

  const config = app.get(ConfigService);
  const port = config.get<number>("port", 3000);

  app.enableCors({
    // origin: true reflects the request's Origin header back, so every
    // origin is allowed while still working with credentials: true
    // (a literal "*" is rejected by browsers when credentials are sent).
    origin: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    // No allowedHeaders => the cors middleware reflects whatever the
    // browser sends in Access-Control-Request-Headers during preflight.
    credentials: true,
  });

  await app.listen(port);
  Logger.log(
    `Tracker-api running on http://localhost:${port}/api`,
    "Bootstrap",
  );
}

bootstrap();
