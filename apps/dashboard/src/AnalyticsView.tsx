import { useEffect, useState, type ReactNode } from 'react';
import type { AnalyticsReport } from '@glance/core';
import { getAnalytics } from './api';

/** Cross-session ("advanced") analytics view — a Pro feature. */
export function AnalyticsView(): JSX.Element {
  const [report, setReport] = useState<AnalyticsReport | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    void getAnalytics().then((r) => {
      if (!alive) return;
      setReport(r);
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  if (!loaded) return <div className="cc-empty">Loading analytics…</div>;
  if (!report)
    return (
      <div className="cc-empty">Advanced analytics is a Pro feature — upgrade to unlock it.</div>
    );
  if (report.sessions === 0)
    return (
      <div className="cc-empty">No archived sessions yet. Stream a little, then come back.</div>
    );

  return (
    <main className="grid">
      <section className="card card-wide">
        <h2 className="card-title">Lifetime</h2>
        <div className="pulse-stats">
          <Stat label="Sessions" value={report.sessions} />
          <Stat label="Messages" value={fmt(report.totalMessages)} />
          <Stat label="Bits" value={fmt(report.totalBits)} />
          <Stat label="Avg msgs / stream" value={fmt(report.avgMessagesPerSession)} />
          <Stat label="Peak chatters" value={report.peakChatters} />
          <Stat label="Hours streamed" value={(report.totalStreamSec / 3600).toFixed(1)} />
        </div>
      </section>

      <section className="card">
        <h2 className="card-title">Top supporters · all time</h2>
        <div className="list">
          {report.topSupporters.length === 0 ? (
            <p className="muted">No supporters yet.</p>
          ) : (
            report.topSupporters.map((s, i) => (
              <div className="supporter" key={s.author}>
                <span className="supporter-rank">{i + 1}</span>
                <span className="supporter-name">{s.author}</span>
                <span className="supporter-bits">{fmt(s.bits)}</span>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="card">
        <h2 className="card-title">Busiest streams</h2>
        <div className="list">
          {report.busiestSessions.map((s) => (
            <div className="health-row" key={s.id}>
              <span className="health-label">
                #{s.channel} · {new Date(s.startedAt).toLocaleDateString()}
              </span>
              <span className="health-value">{fmt(s.messages)} msgs</span>
            </div>
          ))}
        </div>
      </section>

      <section className="card card-wide">
        <h2 className="card-title">Activity by day</h2>
        <div className="list">
          {report.perDay.map((d) => (
            <div className="health-row" key={d.day}>
              <span className="health-label">{d.day}</span>
              <span className="health-value">
                {d.sessions} streams · {fmt(d.messages)} msgs · {fmt(d.bits)} bits
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="card card-wide">
        <h2 className="card-title">Recent recaps</h2>
        <div className="list">
          {report.recentHeadlines.length === 0 ? (
            <p className="muted">No recaps yet.</p>
          ) : (
            report.recentHeadlines.map((h) => (
              <div className="trend" key={h.startedAt}>
                <span className="trend-x">{new Date(h.startedAt).toLocaleDateString()}</span>
                <span className="trend-text">{h.headline}</span>
              </div>
            ))
          )}
        </div>
      </section>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: ReactNode }): JSX.Element {
  return (
    <div className="stat">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

function fmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
