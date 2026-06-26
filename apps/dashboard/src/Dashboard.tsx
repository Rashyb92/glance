import { useEffect, useRef, useState, type ReactNode } from 'react';
import type {
  AudienceMood,
  EngineSettings,
  MomentItem,
  OutputChannel,
  PriorityCallout,
  RoutingMatrix,
  SalienceCategory,
  SessionState,
} from '@glance/core';
import { useStats, type ConnectionStatus } from './useStats';
import { connectSession, disconnectSession, updateSettings } from './api';
import { ReplayView } from './ReplayView';

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
  moderation: 'red',
  highlight: 'soft',
  chatter: 'muted',
};

const ROUTABLE: SalienceCategory[] = [
  'donation',
  'event',
  'question',
  'mention',
  'moderation',
  'trend',
];

export function Dashboard(): JSX.Element {
  const { status, stats, summary, ticker, session, settings, priorities } = useStats();
  const [view, setView] = useState<'live' | 'replay'>('live');
  const channel = session?.channel ?? stats?.channel ?? 'glance';

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
        <div className="cc-tabs">
          <button type="button" className={view === 'live' ? 'on' : ''} onClick={() => setView('live')}>
            Live
          </button>
          <button
            type="button"
            className={view === 'replay' ? 'on' : ''}
            onClick={() => setView('replay')}
          >
            Replay
          </button>
        </div>
        <div className="cc-meta">
          <span className="channel">#{channel}</span>
          {stats && <span className="uptime">{formatUptime(stats.uptimeSec)}</span>}
          <Status status={status} />
        </div>
      </header>

      {view === 'live' && <ConnectBar session={session} />}

      {view === 'replay' ? (
        <ReplayView />
      ) : !stats ? (
        <div className="cc-empty">
          Waiting for the Glance server… start everything with <code>pnpm dev</code>.
        </div>
      ) : (
        <main className="grid">
          {priorities.length > 0 && <PriorityCard priorities={priorities} />}

          <Card title="Live Pulse" wide>
            <div className="pulse">
              <div className={`mood tone-${MOOD_TONE[stats.mood]}`}>
                <span className="mood-dot" />
                <span className="mood-label">{MOOD_LABEL[stats.mood]}</span>
                <span className="mood-sentiment">{formatSentiment(stats.sentiment)}</span>
              </div>
              <div className="pulse-stats">
                <Stat label="Chatters" value={stats.chatters} />
                <Stat label="Msgs / min" value={stats.messagesPerMin} />
                <Stat label="Questions" value={stats.questionsWaiting} />
                <Stat label="Flagged" value={stats.flagged} />
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

          <TuningCard settings={settings} />

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

function PriorityCard({ priorities }: { priorities: PriorityCallout[] }): JSX.Element {
  return (
    <section className="card card-wide">
      <h2 className="card-title">Priority · act now</h2>
      <div className="prio-list">
        {priorities.map((p) => (
          <div className="prio" key={p.id}>
            <span className={`prio-cat tone-${CATEGORY_TONE[p.category]}`}>{p.category}</span>
            <div className="prio-body">
              <div className="prio-reason">{p.reason}</div>
              <div className="prio-text">
                <span className="prio-author">{p.author}</span> {p.text}
              </div>
            </div>
            <span className="prio-src">{p.source === 'ai' ? 'Claude' : 'engine'}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function ConnectBar({ session }: { session: SessionState | null }): JSX.Element {
  const [channel, setChannel] = useState('');
  const [demo, setDemo] = useState(true);
  const [busy, setBusy] = useState(false);

  // Seed the controls from the live session once it arrives.
  useEffect(() => {
    if (!session) return;
    setChannel(session.channel ?? '');
    setDemo(session.demo);
  }, [session?.channel, session?.demo]);

  const current = session?.channel ?? null;
  const connected = session?.connected ?? false;

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="connect">
      <div className="connect-field">
        <span className="connect-hash">#</span>
        <input
          className="connect-input"
          value={channel}
          spellCheck={false}
          placeholder="twitch channel (e.g. xqc) — blank = demo only"
          onChange={(e) => setChannel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void run(() => connectSession(channel, demo));
          }}
        />
      </div>
      <label className="connect-demo">
        <input type="checkbox" checked={demo} onChange={(e) => setDemo(e.target.checked)} />
        demo feed
      </label>
      <button
        className="connect-btn"
        disabled={busy}
        onClick={() => void run(() => connectSession(channel, demo))}
      >
        {current ? 'Switch' : 'Connect'}
      </button>
      {current && (
        <button
          className="connect-btn ghost"
          disabled={busy}
          onClick={() => void run(disconnectSession)}
        >
          Disconnect
        </button>
      )}
      <span className={`connect-state ${connected ? 'on' : ''}`}>
        {current
          ? connected
            ? `listening to #${current}`
            : `connecting to #${current}…`
          : 'not connected'}
      </span>
    </div>
  );
}

function TuningCard({ settings }: { settings: EngineSettings | null }): JSX.Element {
  const [threshold, setThreshold] = useState(0.5);
  const [intervalSec, setIntervalSec] = useState(15);
  const [keywords, setKeywords] = useState('');
  const [routing, setRouting] = useState<RoutingMatrix>({});
  const [aiSummaries, setAiSummaries] = useState(true);
  const [aiPriorities, setAiPriorities] = useState(true);
  const [moderation, setModeration] = useState(true);
  const [sensitivity, setSensitivity] = useState(0.5);
  const [retentionDays, setRetentionDays] = useState(30);
  const [storeText, setStoreText] = useState(true);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const kwFocused = useRef(false);

  useEffect(() => {
    if (!settings) return;
    setThreshold(settings.surfaceThreshold);
    setIntervalSec(Math.round(settings.summaryIntervalMs / 1000));
    setRouting(settings.routing);
    setAiSummaries(settings.aiSummaries);
    setAiPriorities(settings.aiPriorities);
    setModeration(settings.moderation);
    setSensitivity(settings.moderationSensitivity);
    setRetentionDays(settings.retentionDays);
    setStoreText(settings.storeMessageText);
    if (!kwFocused.current) setKeywords(settings.keywords.join(', '));
  }, [settings]);

  const push = (patch: Partial<EngineSettings>): void => {
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => void updateSettings(patch), 250);
  };
  const commitKeywords = (): void => {
    const list = keywords
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    void updateSettings({ keywords: list });
  };

  const toggleRoute = (cat: SalienceCategory, ch: OutputChannel, on: boolean): void => {
    setRouting((prev) => {
      const channels = new Set(prev[cat] ?? []);
      if (on) channels.add(ch);
      else channels.delete(ch);
      const next: RoutingMatrix = { ...prev, [cat]: [...channels] };
      push({ routing: next });
      return next;
    });
  };

  return (
    <Card title="Tuning">
      <div className="tune">
        <label className="tune-row">
          <span>
            Surface threshold <b>{threshold.toFixed(2)}</b>
          </span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={threshold}
            onChange={(e) => {
              const v = Number(e.target.value);
              setThreshold(v);
              push({ surfaceThreshold: v });
            }}
          />
        </label>
        <label className="tune-row">
          <span>
            AI summary every <b>{intervalSec}s</b>
          </span>
          <input
            type="range"
            min={4}
            max={60}
            step={1}
            value={intervalSec}
            onChange={(e) => {
              const v = Number(e.target.value);
              setIntervalSec(v);
              push({ summaryIntervalMs: v * 1000 });
            }}
          />
        </label>

        <div className="tune-checks">
          <label className="tune-check">
            <input
              type="checkbox"
              checked={aiSummaries}
              onChange={(e) => {
                setAiSummaries(e.target.checked);
                push({ aiSummaries: e.target.checked });
              }}
            />
            AI summaries
          </label>
          <label className="tune-check">
            <input
              type="checkbox"
              checked={aiPriorities}
              onChange={(e) => {
                setAiPriorities(e.target.checked);
                push({ aiPriorities: e.target.checked });
              }}
            />
            AI priority callouts
          </label>
          <label className="tune-check">
            <input
              type="checkbox"
              checked={moderation}
              onChange={(e) => {
                setModeration(e.target.checked);
                push({ moderation: e.target.checked });
              }}
            />
            Moderation flagging
          </label>
        </div>
        {moderation && (
          <label className="tune-row">
            <span>
              Moderation sensitivity <b>{sensitivity.toFixed(2)}</b>
              <span className="hint-sm"> lower = stricter</span>
            </span>
            <input
              type="range"
              min={0.2}
              max={0.9}
              step={0.05}
              value={sensitivity}
              onChange={(e) => {
                const v = Number(e.target.value);
                setSensitivity(v);
                push({ moderationSensitivity: v });
              }}
            />
          </label>
        )}

        <label className="tune-row">
          <span>Keywords to boost</span>
          <input
            className="tune-input"
            type="text"
            value={keywords}
            placeholder="food, tomorrow, giveaway"
            onFocus={() => {
              kwFocused.current = true;
            }}
            onChange={(e) => setKeywords(e.target.value)}
            onBlur={() => {
              kwFocused.current = false;
              commitKeywords();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitKeywords();
            }}
          />
        </label>

        <div className="tune-row">
          <span>Route what to where</span>
          <div className="routing">
            <div className="routing-head">
              <span />
              <span>see</span>
              <span>hear</span>
              <span>chime</span>
            </div>
            {ROUTABLE.map((cat) => (
              <div className="routing-row" key={cat}>
                <span className="routing-cat">{cat}</span>
                {(['display', 'voice', 'earcon'] as const).map((ch) => (
                  <input
                    key={ch}
                    type="checkbox"
                    aria-label={`${cat} ${ch}`}
                    checked={(routing[cat] ?? []).includes(ch)}
                    onChange={(e) => toggleRoute(cat, ch, e.target.checked)}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>

        <div className="tune-checks">
          <label className="tune-check">
            <input
              type="checkbox"
              checked={storeText}
              onChange={(e) => {
                setStoreText(e.target.checked);
                push({ storeMessageText: e.target.checked });
              }}
            />
            Store chat text in replays
            <span className="hint-sm"> off = privacy mode (metadata only)</span>
          </label>
        </div>
        <label className="tune-row">
          <span>
            Keep replays <b>{retentionDays === 0 ? 'forever' : `${retentionDays} days`}</b>
          </span>
          <input
            type="range"
            min={0}
            max={365}
            step={1}
            value={retentionDays}
            onChange={(e) => {
              const v = Number(e.target.value);
              setRetentionDays(v);
              push({ retentionDays: v });
            }}
          />
        </label>
      </div>
    </Card>
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

function formatSentiment(s: number): string {
  if (s > 0.05) return `mood +${s.toFixed(2)}`;
  if (s < -0.05) return `mood ${s.toFixed(2)}`;
  return 'mood neutral';
}

function formatUptime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}
