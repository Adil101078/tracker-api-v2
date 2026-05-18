/**
 * Dev seed: inserts N realistic tracker entries straight into MongoDB
 * (bypasses the BullMQ queue for speed). Spreads createdAt across the
 * last 30 days so the dashboard's time-series / heatmap / date filters
 * have meaningful data.
 *
 *   npm run seed            # 1000 docs
 *   npm run seed -- 5000    # custom count
 *   npm run seed -- 1000 --fresh   # wipe collection first
 */
import { NestFactory } from '@nestjs/core';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AppModule } from './app.module';
import { Tracker } from '@modules/tracker/schemas/tracker.schema';

const COMPANIES = ['FTJ', 'ACME', 'ONLY4TRIP', 'SKYWAYS', 'GLOBETROT'];
const ENDPOINTS = [
  '/search',
  '/farequote',
  '/availability',
  '/book',
  '/ticket',
];
const ORIGINS = ['DXB', 'JFK', 'LHR', 'SIN', 'DEL', 'BKK', 'CDG', 'SYD'];
const DESTS = ['LHR', 'LAX', 'DXB', 'HKG', 'BOM', 'FRA', 'NRT', 'AUH'];
const CLASSES = ['Y', 'C', 'F', 'W'];
const CURRENCIES = ['USD', 'AED', 'EUR', 'INR', 'GBP'];
// Public IPs spanning several countries (resolved by the geo worker if
// you re-ingest via the API; seeded geo is set directly here instead).
const GEO = [
  { IP: '8.8.8.8', country: 'United States', countryCode: 'US', city: 'Ashburn' },
  { IP: '1.1.1.1', country: 'Australia', countryCode: 'AU', city: 'Sydney' },
  { IP: '49.36.0.1', country: 'India', countryCode: 'IN', city: 'Mumbai' },
  { IP: '94.200.0.1', country: 'United Arab Emirates', countryCode: 'AE', city: 'Dubai' },
  { IP: '171.5.0.1', country: 'Thailand', countryCode: 'TH', city: 'Bangkok' },
  { IP: '36.66.0.1', country: 'Indonesia', countryCode: 'ID', city: 'Jakarta' },
];

const pick = <T>(a: T[]): T => a[Math.floor(Math.random() * a.length)];
const rnd = (min: number, max: number) =>
  Math.floor(Math.random() * (max - min + 1)) + min;

type SeedDoc = Partial<Tracker> & { createdAt: Date };

function buildDoc(): SeedDoc {
  const company = pick(COMPANIES);
  const endpoint = pick(ENDPOINTS);
  const geo = pick(GEO);

  // ~97% success; /book is the slow + error-prone one (mirrors the UI).
  const isBook = endpoint === '/book';
  const success = Math.random() > (isBook ? 0.03 : 0.01);
  const statusCode = success
    ? 200
    : pick([400, 401, 422, 500, 502, 503]);

  // Spread over the last 30 days, weighted slightly toward recent days.
  const daysAgo = Math.floor(Math.pow(Math.random(), 1.5) * 30);
  const createdAt = new Date(
    Date.now() -
      daysAgo * 86_400_000 -
      rnd(0, 86_399) * 1000,
  );

  return {
    companyCode: company,
    credentialCode: `${company}-CRED-${rnd(1, 5)}`,
    secretKey: `sk_${Math.random().toString(36).slice(2, 12)}`,
    referralUrl: `https://${company.toLowerCase()}.example.com/flights`,
    searchId: `s-${Math.random().toString(36).slice(2, 10)}`,
    origin: pick(ORIGINS),
    destination: pick(DESTS),
    classOfService: pick(CLASSES),
    adults: String(rnd(1, 4)),
    child: String(rnd(0, 2)),
    infants: String(rnd(0, 1)),
    currency: pick(CURRENCIES),
    departureDate: '',
    returnDate: '',
    endpoint,
    httpMethod: endpoint === '/search' ? 'GET' : 'POST',
    statusCode,
    success,
    responseTimeMs: isBook ? rnd(300, 900) : rnd(80, 400),
    userAgent:
      Math.random() > 0.9
        ? 'bot/crawler 1.0'
        : 'Mozilla/5.0 (compatible)',
    isBot: Math.random() > 0.9,
    isBlocked: Math.random() > 0.97,
    IP: geo.IP,
    country: geo.country,
    countryCode: geo.countryCode,
    city: geo.city,
    createdAt,
  } as SeedDoc;
}

async function run() {
  const args = process.argv.slice(2);
  const count = Number(args.find((a) => /^\d+$/.test(a))) || 1000;
  const fresh = args.includes('--fresh');

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  const model = app.get<Model<Tracker>>(getModelToken(Tracker.name));

  if (fresh) {
    const { deletedCount } = await model.deleteMany({});
    console.log(`Cleared ${deletedCount} existing docs`);
  }

  const docs = Array.from({ length: count }, () => {
    const d = buildDoc();
    // updatedAt mirrors our explicit createdAt (timestamps would override).
    return { ...d, updatedAt: d.createdAt };
  });

  // Insert via the native driver so our explicit createdAt/updatedAt are
  // kept verbatim (the Mongoose layer would stamp timestamps over them).
  await model.collection.insertMany(docs as Record<string, unknown>[]);

  const total = await model.estimatedDocumentCount();
  console.log(`Inserted ${count} docs. Collection now ~${total} total.`);
  await app.close();
  process.exit(0);
}

run().catch((e) => {
  console.error('Seed failed:', e);
  process.exit(1);
});
