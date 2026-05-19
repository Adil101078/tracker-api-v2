/**
 * Centralised application constants.
 */
const constant = {
  MODELS: {
    TRACKER: "api_call_tracker",
    COMPANY_SUMMARY: "CompanySummary",
    HOURLY_COMPANY_STATS: "HourlyCompanyStats",
  },
  QUEUES: {
    TRACKER: "tracker-queue",
  },
  JOBS: {
    PERSIST_TRACKER: "persist-tracker",
  },
} as const;

export default constant;
