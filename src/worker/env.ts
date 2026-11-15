export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  AI: Ai;
  ASSETS: Fetcher;
  /** Background AI jobs (optional: without it, jobs run in waitUntil). */
  JOBS?: Queue<{ intakeId: string; userId: string }>;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  AI_GATEWAY_ID: string;
  /** Local development only: "1" bypasses Access and uses DEV_USER_EMAIL. */
  DEV_AUTH?: string;
  DEV_USER_EMAIL?: string;
  USDA_API_KEY?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
}

export interface User {
  id: string;
  access_sub: string;
  email: string | null;
  timezone: string;
}

export type AppEnv = { Bindings: Env; Variables: { user: User } };
