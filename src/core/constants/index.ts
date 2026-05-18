/**
 * Centralised application constants.
 */
const constant = {
  MODELS: {
    TRACKER: 'Tracker',
  },
  QUEUES: {
    TRACKER: 'tracker-queue',
  },
  JOBS: {
    PERSIST_TRACKER: 'persist-tracker',
  },
} as const;

export default constant;
