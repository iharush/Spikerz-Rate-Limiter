import { Tooltip } from '@mui/material';

export interface ActivityBucket {
  at: string;
  regular: number;
  bypassed: number;
  denied: number;
}

export function ActivityChart({
  buckets,
  range,
  now,
}: {
  buckets: ActivityBucket[];
  range: 'hour' | 'day';
  now: number;
}) {
  const step = range === 'hour' ? 60_000 : 3_600_000;
  const duration = range === 'hour' ? 3_600_000 : 86_400_000;
  const start = Math.floor((now - duration) / step) * step;
  const end = Math.floor(now / step) * step;
  const values = new Map(buckets.map((bucket) => [Date.parse(bucket.at), bucket]));
  // Empty intervals keep recent bursts near "Now", rather than compressing a
  // quiet hour/day down to one left-aligned bar.
  const timeline = Array.from({ length: (end - start) / step + 1 }, (_, index) => {
    const time = start + index * step;
    return (
      values.get(time) ?? { at: new Date(time).toISOString(), regular: 0, bypassed: 0, denied: 0 }
    );
  });
  const maximum = Math.max(...timeline.map((row) => row.regular + row.bypassed + row.denied), 1);
  return (
    <>
      <div className="chart-legend">
        <span>
          <i className="regular" />
          Regular
        </span>
        <span>
          <i className="bypassed" />
          Bypassed
        </span>
        <span>
          <i className="denied" />
          Denied
        </span>
      </div>
      <div
        className="history-chart"
        role="img"
        aria-label={`Request decisions for the past ${range}`}
      >
        {timeline.map((bucket) => (
          <Tooltip
            key={bucket.at}
            title={`${new Date(bucket.at).toLocaleString()}: ${bucket.regular} regular, ${bucket.bypassed} bypassed, ${bucket.denied} denied`}
          >
            <div className="chart-column">
              {(['denied', 'bypassed', 'regular'] as const).map((kind) => (
                <div
                  key={kind}
                  className={kind}
                  style={{ height: `${(bucket[kind] / maximum) * 110}px` }}
                />
              ))}
            </div>
          </Tooltip>
        ))}
      </div>
      <div className="chart-axis">
        <small>{range === 'hour' ? '60 minutes ago' : '24 hours ago'}</small>
        <small>Now</small>
      </div>
    </>
  );
}
