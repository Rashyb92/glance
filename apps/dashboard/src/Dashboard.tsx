import type { ReactNode } from 'react';
import type { AudienceMood, MomentItem, SalienceCategory } from '@glance/core';
import { useStats, type ConnectionStatus } from './useStats';

type Tone = 'gold' | 'blue' | 'indigo' | 'teal' | 'soft' | 'muted' | 'red';

const MOOD_TONE: Record<AudienceMood, Tone> = {
  hyped: 'gold',
  positive: 'teal',
  neutral: 'muted',
  restless: 'blue',
  negative: 'red',
};
const MOOD_LABEL: Record<AudienceMood, string> = {
  hyped: 'Hyped',
  positive: 'Positive',
  neutral: 'Neutral',
  restless: 'Restless',
  negative: 'Tense',
};
const CATEGORY_TONE: Record<SalienceCategory, Tone> = {
  donation: 'gold',
  event: 'gold',
  question: 'blue',
  trend: 'indigo',
  mention: 'teal',
  highlight: 'soft',
  chatter: 'muted',
};

export function Dashboard(): JSX.Element {
  const { status, stats, summary, ticker } = useStats();
  const channel = stats?.channel ?? 'glance';

  return (
    <div className="cc">
      <header className="cc-top">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            ◐
          </span>
          GLANCE
          <span className="brand-sub">Command Center</span>
        </div>
        <div className="cc-meta">
          <span className="channel">#{channel}</span>
          {stats && <span className="uptime">{formatUptime(stats.uptimeSec)}</span>}
          <Status status={status} />
        </div>
      </header>

      {!stats ? (
        <div className="cc-empty">
          Waiting for the Glance server… start everything with <code>pnpm dev</code>.
        </div>
      ) : (
        <main className="grid">
          <Card title="Live Pulse" wide>
            <div className="pulse">
              <div className={`mood tone-${MOOD_TONE[stats.mood]}`}>
                <span className="mood-dot" />
                <span className="mood-label">{MOOD_LABEL[stats.mood]}</span>
              </div>
              <div className="pulse-stats">
                <Stat label="Chatters" value={stats.chatters} />
                <Stat label="Msgs / min" value={stats.messagesPerMin} />
                <Stat label="Questions" value={stats.questionsWaiting} />
              </div>
            </div>
            <Meter label="Hype" pct={stats.hype} tone={MOOD_TONE[stats.mood]} />
          </Card>

          <Card title="Monetization">
            <div className="big tone-gold">
              {formatNum(stats.bitsTotal)} <span className="unit">bits</span>
            </div>
            <div className="row-stats">
              <Stat label="Cheers" value={stats.cheers} />
              <Stat label="Gift subs" value={stats.giftSubs} />
            </div>
            <div className="list">
              {stats.topSupporters.length === 0 ? (
                <p className="muted">No supporters yet.</p>
              ) : (
                stats.topSupporters.map((s, i) => (
                  <SupporterRow
                    key={s.author}
                    rank={i + 1}
                    author={s.author}
                    bits={s.bits}
                    max={stats.topSupporters[0]?.bits ?? 1}
                  />
                ))
              )}
            </div>
          </Card>

          <Card title="AI Insights">
            {summary ? (
              <div className="insight">
                <span className="tag">{summary.source === 'ai' ? 'Claude' : 'Engine'}</span>
                <p className="insight-headline">{summary.headline}</p>
              </div>
            ) : (
              <p className="muted">Listening for the room…</p>
            )}
            <div className="list">
              <div className="list-label">Trends</div>
              {stats.trends.length === 0 ? (
                <p className="muted">No trends yet.</p>
              ) : (
                stats.trends.map((t) => (
                  <div className="trend" key={t.phrase}>
                    <span className="trend-x">×{t.count}</span>
                    <span className="trend-text">{t.phrase}</span>
                  </div>
                ))
              )}
            </div>
          </Card>

          <Card title="Session Replay · Best Moments" wide>
            <div className="moments">
              {stats.bestMoments.length === 0 ? (
                <p className="muted">Moments will appear as the stream heats up.</p>
              ) : (
                stats.bestMoments.map((m) => <MomentRow key={m.id} moment={m} />)
              )}
            </div>
          </Card>

          <Card title="Stream Health">
            <div className="health">
              <HealthRow
                label="Connection"
                value={status === 'online' ? 'Online' : status}
                tone={status === 'online' ? 'teal' : 'red'}
              />
              <HealthRow label="Messages read" value={formatNum(stats.messagesTotal)} />
              <HealthRow label="Events" value={String(stats.eventsTotal)} />
              <HealthRow label="Uptime" value={formatUptime(stats.uptimeSec)} />
            </div>
            <div className="targets">
              <span className="target is-on">Browser HUD · live</span>
              <span className="target">Meta Display · planned</span>
              <span className="target">Brilliant Labs · planned</span>
            </div>
          </Card>

          <Card title="Live ticker">
            <div className="ticker">
              {ticker.length === 0 ? (
                <p className="muted">Quiet — only what matters shows here.</p>
              ) : (
                ticker.map((m) => (
                  <div className="tick" key={m.message.id}>
                    <span className={`tick-chip tone-${CATEGORY_TONE[m.category]}`} />
                    <span className="tick-author">{m.message.author}</span>
                    <span className="tick-text">{m.message.text}</span>
                  </div>
                ))
              )}
            </div>
          </Card>
        </main>
      )}
    </div>
  );
}

function Card({
  title,
  wide,
  children,
}: {
  title: string;
  wide?: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className={`card ${wide ? 'card-wide' : ''}`}>
      <h2 className="card-title">{title}</h2>
      {children}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: number | string }): JSX.Element {
  return (
    <div className="stat">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

function Meter({ label, pct, tone }: { label: string; pct: number; tone: Tone }): JSX.Element {
  return (
    <div className="meter">
      <div className="meter-head">
        <span>{label}</span>
        <span>{pct}</span>
      </div>
      <div className="meter-track">
        <div className={`meter-fill tone-${tone}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function SupporterRow({
  rank,
  author,
  bits,
  max,
}: {
  rank: number;
  author: string;
  bits: number;
  max: number;
}): JSX.Element {
  return (
    <div className="supporter">
      <span className="supporter-rank">{rank}</span>
      <span className="supporter-name">{author}</span>
      <span className="supporter-bar">
        <span className="supporter-fill" style={{ width: `${Math.round((bits / max) * 100)}%` }} />
      </span>
      <span className="supporter-bits">{formatNum(bits)}</span>
    </div>
  );
}

function MomentRow({ moment }: { moment: MomentItem }): JSX.Element {
  return (
    <div className="moment">
      <span className={`moment-score tone-${CATEGORY_TONE[moment.category]}`}>
        {Math.round(moment.score * 100)}
      </span>
      <div className="moment-body">
        <span className="moment-author">{moment.author}</span>
        <span className="moment-text">{moment.text}</span>
      </div>
    </div>
  );
}

function HealthRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: Tone;
}): JSX.Element {
  return (
    <div className="health-row">
      <span className="health-label">{label}</span>
      <span className={`health-value ${tone ? `tone-${tone}` : ''}`}>{value}</span>
    </div>
  );
}

function Status({ status }: { status: ConnectionStatus }): JSX.Element {
  const label = status === 'online' ? 'live' : status;
  return (
    <span className={`status status-${status}`}>
      <span className="status-dot" />
      {label}
    </span>
  );
}

function formatNum(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function formatUptime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}
