/**
 * Default metrics and query parameters for Instagram insights.
 *
 * `impressions` was removed from IG media and user insights in Graph API v22
 * (all versions since 2025-04-21), so the defaults use `reach` and `views`.
 * At account level, `views` is only available with metric_type=total_value.
 */

export const DEFAULT_ACCOUNT_METRICS = ["reach", "views"] as const;
export const DEFAULT_MEDIA_METRICS = ["reach", "views"] as const;

export type IgMetricType = "time_series" | "total_value";

export interface AccountInsightsInput {
  metrics?: string[];
  period?: "day" | "week" | "days_28";
  since?: string;
  until?: string;
  metric_type?: IgMetricType;
}

/** Query params for GET /{ig-user-id}/insights (without access_token). */
export function buildAccountInsightsParams(input: AccountInsightsInput): Record<string, string> {
  const usingDefaults = !input.metrics || input.metrics.length === 0;
  const params: Record<string, string> = {
    metric: (usingDefaults ? [...DEFAULT_ACCOUNT_METRICS] : input.metrics!).join(","),
    period: input.period ?? "day",
  };
  // The default set includes `views`, which needs total_value. With caller-chosen
  // metrics we only send metric_type when asked (follower_count, for example,
  // is time-series only).
  const metricType = input.metric_type ?? (usingDefaults ? "total_value" : undefined);
  if (metricType) params.metric_type = metricType;
  if (input.since) params.since = input.since;
  if (input.until) params.until = input.until;
  return params;
}

/** Query params for GET /{ig-media-id}/insights (without access_token). */
export function buildMediaInsightsParams(metrics?: string[]): Record<string, string> {
  const list = metrics && metrics.length > 0 ? metrics : [...DEFAULT_MEDIA_METRICS];
  return { metric: list.join(",") };
}
