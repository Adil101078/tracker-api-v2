import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Queue } from 'bullmq';
import { Connection } from 'mongoose';
import constant from '@core/constants';

export type ComponentStatus = 'operational' | 'down';

export interface HealthComponent {
  name: string;
  status: ComponentStatus;
  /** 100 when operational, 0 when down — matches the UI's % display. */
  uptimePercent: number;
}

export interface HealthReport {
  overall: ComponentStatus;
  message: string;
  components: HealthComponent[];
  checkedAt: string;
}

/**
 * Reports liveness of the real infrastructure behind the dashboard's
 * "System Health" panel. The mock UI's "Search Engine" is intentionally
 * omitted — no search engine exists in this stack.
 */
@Injectable()
export class HealthService {
  constructor(
    @InjectConnection() private readonly mongoConnection: Connection,
    @InjectQueue(constant.QUEUES.TRACKER) private readonly queue: Queue,
  ) {}

  private async check(
    name: string,
    probe: () => Promise<boolean>,
  ): Promise<HealthComponent> {
    let ok = false;
    try {
      ok = await probe();
    } catch {
      ok = false;
    }
    return {
      name,
      status: ok ? 'operational' : 'down',
      uptimePercent: ok ? 100 : 0,
    };
  }

  async getReport(): Promise<HealthReport> {
    const components = await Promise.all([
      // API Gateway = this service. If this code runs, it is up.
      this.check('API Gateway', async () => true),

      // Database = MongoDB. readyState 1 === connected; ping confirms it.
      this.check('Database', async () => {
        if (this.mongoConnection.readyState !== 1) return false;
        const db = this.mongoConnection.db;
        if (!db) return false;
        await db.admin().ping();
        return true;
      }),

      // Cache Server = Redis (BullMQ's connection). PING must return PONG.
      this.check('Cache Server', async () => {
        const client = await this.queue.client;
        return (await client.ping()) === 'PONG';
      }),

      // Message Queue = the BullMQ queue itself is reachable.
      this.check('Message Queue', async () => {
        await this.queue.getJobCounts();
        return true;
      }),
    ]);

    const allUp = components.every((c) => c.status === 'operational');
    return {
      overall: allUp ? 'operational' : 'down',
      message: allUp ? 'All Systems Operational' : 'Degraded',
      components,
      checkedAt: new Date().toISOString(),
    };
  }
}
