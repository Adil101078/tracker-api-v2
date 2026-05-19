/**
 * One-time (and re-runnable) backfill for BOTH dashboard rollups:
 *   1. CompanySummary      — one doc per company (powers the dropdown).
 *   2. HourlyCompanyStats  — the per-(company, hour) cube that serves
 *                            every date-filtered dashboard aggregation.
 *
 * Both rollups are only maintained for hits persisted AFTER they were
 * added, so existing rows (your ~1M historical hits) won't appear in the
 * dashboard until this runs.
 *
 * Each rebuild is one server-side aggregation ending in $merge: Mongo
 * streams the raw collection once and writes the rollup docs. Safe to
 * re-run — $merge replaces each rollup doc with freshly recomputed
 * values, so it also self-heals any drift from the best-effort live
 * updates.
 *
 *   npm run backfill:summary
 *
 * Run it during a quiet window: hits landing DURING the run can be
 * transiently double-counted (once by the live $inc, once by this
 * recompute). Re-running afterwards converges to the correct totals.
 */
import { NestFactory } from '@nestjs/core';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AppModule } from './app.module';
import { Tracker } from '@modules/tracker/schemas/tracker.schema';
import { CompanySummary } from '@modules/tracker/schemas/company-summary.schema';
import { HourlyCompanyStats } from '@modules/tracker/schemas/hourly-company-stats.schema';

async function run() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  const trackerModel = app.get<Model<Tracker>>(
    getModelToken(Tracker.name),
  );
  const summaryModel = app.get<Model<CompanySummary>>(
    getModelToken(CompanySummary.name),
  );
  const cubeModel = app.get<Model<HourlyCompanyStats>>(
    getModelToken(HourlyCompanyStats.name),
  );
  const summaryColl = summaryModel.collection.collectionName;
  const cubeColl = cubeModel.collection.collectionName;

  const startedAt = Date.now();

  // ---- 1. CompanySummary (one doc per company) ----
  console.log('Recomputing CompanySummary from raw hits…');
  await trackerModel
    .aggregate(
      [
        {
          $group: {
            _id: '$companyCode',
            totalHits: { $sum: 1 },
            successCount: { $sum: { $cond: ['$success', 1, 0] } },
            errorCount: {
              $sum: { $cond: [{ $eq: ['$success', false] }, 1, 0] },
            },
            totalResponseTimeMs: {
              $sum: { $ifNull: ['$responseTimeMs', 0] },
            },
            responseTimeSamples: {
              $sum: {
                $cond: [
                  { $eq: [{ $type: '$responseTimeMs' }, 'missing'] },
                  0,
                  1,
                ],
              },
            },
            firstHit: { $min: '$createdAt' },
            lastHit: { $max: '$createdAt' },
          },
        },
        {
          $project: {
            _id: 0,
            companyCode: '$_id',
            totalHits: 1,
            successCount: 1,
            errorCount: 1,
            totalResponseTimeMs: 1,
            responseTimeSamples: 1,
            firstHit: 1,
            lastHit: 1,
            updatedAt: '$$NOW',
          },
        },
        {
          $merge: {
            into: summaryColl,
            on: 'companyCode',
            whenMatched: 'replace',
            whenNotMatched: 'insert',
          },
        },
      ],
      { allowDiskUse: true },
    )
    .exec();

  // ---- 2. HourlyCompanyStats cube (one doc per company+hour) ----
  //
  // Built in two grouping passes that stay in the same pipeline:
  //   a) group by (company, hour, endpoint)  -> per-endpoint sub-totals
  //   b) regroup by (company, hour)          -> flat totals + assemble
  //      the endpoints/statusBuckets/countries maps via $arrayToObject.
  // Status + country sub-aggregates are accumulated alongside (a) using
  // $push of {k,v} pairs, then $arrayToObject builds the maps. Counts
  // are summed per key first so $arrayToObject gets one entry per key.
  console.log('Recomputing HourlyCompanyStats cube from raw hits…');
  await trackerModel
    .aggregate(
      [
        {
          $project: {
            companyCode: 1,
            success: 1,
            isBlocked: 1,
            responseTimeMs: 1,
            country: 1,
            countryCode: 1,
            createdAt: 1,
            endpointKey: {
              $replaceAll: {
                input: {
                  $replaceAll: {
                    input: { $ifNull: ['$endpoint', 'unknown'] },
                    find: '.',
                    replacement: '_',
                  },
                },
                find: '$',
                replacement: '_',
              },
            },
            statusKey: {
              $cond: [
                { $eq: [{ $type: '$statusCode' }, 'missing'] },
                'unknown',
                {
                  $concat: [
                    {
                      $toString: {
                        $floor: { $divide: ['$statusCode', 100] },
                      },
                    },
                    'xx',
                  ],
                },
              ],
            },
            bucketHour: {
              $dateTrunc: { date: '$createdAt', unit: 'hour' },
            },
            hasRt: {
              $cond: [
                { $eq: [{ $type: '$responseTimeMs' }, 'missing'] },
                0,
                1,
              ],
            },
            rt: { $ifNull: ['$responseTimeMs', 0] },
          },
        },
        // (a) finest grouping: company + hour + endpoint + status + cc
        {
          $group: {
            _id: {
              companyCode: '$companyCode',
              bucketHour: '$bucketHour',
              endpointKey: '$endpointKey',
              statusKey: '$statusKey',
              countryCode: '$countryCode',
            },
            country: { $last: '$country' },
            hits: { $sum: 1 },
            successCount: {
              $sum: { $cond: [{ $eq: ['$success', true] }, 1, 0] },
            },
            errorCount: {
              $sum: { $cond: [{ $eq: ['$success', false] }, 1, 0] },
            },
            blockedCount: {
              $sum: { $cond: [{ $eq: ['$isBlocked', true] }, 1, 0] },
            },
            totalResponseTimeMs: { $sum: '$rt' },
            responseTimeSamples: { $sum: '$hasRt' },
          },
        },
        // (b) collapse to one doc per (company, hour); build the maps.
        {
          $group: {
            _id: {
              companyCode: '$_id.companyCode',
              bucketHour: '$_id.bucketHour',
            },
            totalHits: { $sum: '$hits' },
            successCount: { $sum: '$successCount' },
            errorCount: { $sum: '$errorCount' },
            blockedCount: { $sum: '$blockedCount' },
            totalResponseTimeMs: { $sum: '$totalResponseTimeMs' },
            responseTimeSamples: { $sum: '$responseTimeSamples' },
            endpointRows: {
              $push: {
                k: '$_id.endpointKey',
                hits: '$hits',
                successCount: '$successCount',
                totalResponseTimeMs: '$totalResponseTimeMs',
              },
            },
            statusRows: {
              $push: { k: '$_id.statusKey', v: '$hits' },
            },
            countryRows: {
              $push: {
                cc: '$_id.countryCode',
                country: '$country',
                hits: '$hits',
              },
            },
          },
        },
        {
          $project: {
            _id: 0,
            companyCode: '$_id.companyCode',
            bucketHour: '$_id.bucketHour',
            totalHits: 1,
            successCount: 1,
            errorCount: 1,
            blockedCount: 1,
            totalResponseTimeMs: 1,
            responseTimeSamples: 1,
            firstHit: '$_id.bucketHour',
            lastHit: '$_id.bucketHour',
            // endpoints: re-fold rows sharing an endpoint key (status/cc
            // splits produced duplicates) then $arrayToObject.
            endpoints: {
              $arrayToObject: {
                $map: {
                  input: {
                    $setUnion: {
                      $map: { input: '$endpointRows', in: '$$this.k' },
                    },
                  },
                  as: 'key',
                  in: {
                    k: '$$key',
                    v: {
                      $let: {
                        vars: {
                          rows: {
                            $filter: {
                              input: '$endpointRows',
                              cond: { $eq: ['$$this.k', '$$key'] },
                            },
                          },
                        },
                        in: {
                          hits: { $sum: '$$rows.hits' },
                          successCount: { $sum: '$$rows.successCount' },
                          totalResponseTimeMs: {
                            $sum: '$$rows.totalResponseTimeMs',
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            statusBuckets: {
              $arrayToObject: {
                $map: {
                  input: {
                    $setUnion: {
                      $map: { input: '$statusRows', in: '$$this.k' },
                    },
                  },
                  as: 'key',
                  in: {
                    k: '$$key',
                    v: {
                      $sum: {
                        $map: {
                          input: {
                            $filter: {
                              input: '$statusRows',
                              cond: { $eq: ['$$this.k', '$$key'] },
                            },
                          },
                          in: '$$this.v',
                        },
                      },
                    },
                  },
                },
              },
            },
            // countries: skip null/empty countryCode (matches the live
            // path, which never writes a country bucket without geo).
            countries: {
              $arrayToObject: {
                $map: {
                  input: {
                    $setUnion: {
                      $map: {
                        input: {
                          $filter: {
                            input: '$countryRows',
                            cond: {
                              $and: [
                                { $ne: ['$$this.cc', null] },
                                { $ne: ['$$this.cc', ''] },
                              ],
                            },
                          },
                        },
                        in: '$$this.cc',
                      },
                    },
                  },
                  as: 'key',
                  in: {
                    k: '$$key',
                    v: {
                      $let: {
                        vars: {
                          rows: {
                            $filter: {
                              input: '$countryRows',
                              cond: { $eq: ['$$this.cc', '$$key'] },
                            },
                          },
                        },
                        in: {
                          hits: { $sum: '$$rows.hits' },
                          country: { $first: '$$rows.country' },
                        },
                      },
                    },
                  },
                },
              },
            },
            updatedAt: '$$NOW',
          },
        },
        {
          $merge: {
            into: cubeColl,
            on: ['companyCode', 'bucketHour'],
            whenMatched: 'replace',
            whenNotMatched: 'insert',
          },
        },
      ],
      { allowDiskUse: true },
    )
    .exec();

  const [companies, buckets] = await Promise.all([
    summaryModel.estimatedDocumentCount(),
    cubeModel.estimatedDocumentCount(),
  ]);

  console.log(
    `Done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s — ` +
      `${companies} company summary docs, ${buckets} hourly cube docs.`,
  );
  await app.close();
  process.exit(0);
}

run().catch((e) => {
  console.error('Backfill failed:', e);
  process.exit(1);
});
