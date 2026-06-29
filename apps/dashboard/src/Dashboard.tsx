import { useEffect, useRef, useState, type ReactNode } from 'react';
import type {
  AudienceMood,
  Branding,
  ChatPace,
  EngineSettings,
  MomentItem,
  OutputChannel,
  PriorityCallout,
  RoutingMatrix,
  SalienceCategory,
  SessionState,
  TeamMember,
} from '@glance/core';
import { PLANS } from '@glance/core';
import { useStats, type ConnectionStatus } from './useStats';
import {
  connectSessionMany,
  disconnectSession,
  inviteMember,
  listTeam,
  memberLoginToken,
  oauthStartUrl,
  openBillingPortal,
  removeMember,
  startCheckout,
  updateSettings,
} from './api';
import { requestPairLink, HUD_URL, COMPANION_URL } from './auth';
import { ReplayView } from './ReplayView';
import { AnalyticsView } from './AnalyticsView';

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
  const [view, setView] = useState<'live' | 'replay' | 'analytics'>('live');
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
          <button
            type="button"
            className={view === 'live' ? 'on' : ''}
            onClick={() => setView('live')}
          >
            Live
          </button>
          <button
            type="button"
            className={view === 'replay' ? 'on' : ''}
            onClick={() => setView('replay')}
          >
            Replay
          </button>
          <button
            type="button"
            className={view === 'analytics' ? 'on' : ''}
            onClick={() => setView('analytics')}
          >
            Analytics
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
      ) : view === 'analytics' ? (
        <AnalyticsView />
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
                <Stat label="Watching" value={session?.viewers ?? '—'} />
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

          <AccountCard />

          <TeamCard />

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

type ConnectRow = { channel: string; platform: 'twitch' | 'youtube' | 'kick' };
const MAX_CONNECT_ROWS = 3;

function ConnectBar({ session }: { session: SessionState | null }): JSX.Element {
  const [rows, setRows] = useState<ConnectRow[]>([{ channel: '', platform: 'twitch' }]);
  const [demo, setDemo] = useState(true);
  const [busy, setBusy] = useState(false);

  // Seed the controls from the live session (and re-seed when its channel set changes).
  const channelsKey = session?.channels.map((c) => `${c.platform}:${c.channel}`).join(',') ?? '';
  useEffect(() => {
    if (!session) return;
    setDemo(session.demo);
    if (session.channels.length > 0) {
      setRows(
        session.channels.map((c) => ({
          channel: c.channel,
          platform: c.platform === 'demo' ? 'twitch' : c.platform,
        })),
      );
    }
  }, [channelsKey, session?.demo]);

  const connected = session?.connected ?? false;
  const live = session?.channels ?? [];

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  const go = (): Promise<void> =>
    connectSessionMany(
      rows
        .filter((r) => r.channel.trim())
        .map((r) => ({ platform: r.platform, channel: r.channel.trim() })),
      demo,
    );
  const setRow = (i: number, patch: Partial<ConnectRow>): void =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <div className="connect">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minWidth: 240 }}>
        {rows.map((row, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className="connect-hash">#</span>
            <input
              className="connect-input"
              style={{ flex: 1 }}
              value={row.channel}
              spellCheck={false}
              placeholder={
                i === 0 ? 'channel (e.g. xqc) — blank = demo only' : 'add another channel'
              }
              onChange={(e) => setRow(i, { channel: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void run(go);
              }}
            />
            <select
              className="connect-platform"
              value={row.platform}
              aria-label="Platform"
              onChange={(e) => setRow(i, { platform: e.target.value as ConnectRow['platform'] })}
            >
              <option value="twitch">Twitch</option>
              <option value="youtube">YouTube</option>
              <option value="kick">Kick</option>
            </select>
            {rows.length > 1 && (
              <button
                type="button"
                aria-label="Remove channel"
                onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: '#9a9aa6',
                  cursor: 'pointer',
                  fontSize: 18,
                }}
              >
                ×
              </button>
            )}
          </div>
        ))}
        {rows.length < MAX_CONNECT_ROWS && (
          <button
            type="button"
            onClick={() => setRows((rs) => [...rs, { channel: '', platform: 'twitch' }])}
            style={{
              alignSelf: 'flex-start',
              background: 'transparent',
              border: '1px dashed #3a3a44',
              color: '#b9b9c6',
              borderRadius: 8,
              padding: '4px 10px',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            + Add channel (simulcast)
          </button>
        )}
      </div>
      <label className="connect-demo">
        <input type="checkbox" checked={demo} onChange={(e) => setDemo(e.target.checked)} />
        demo feed
      </label>
      <button className="connect-btn" disabled={busy} onClick={() => void run(go)}>
        {live.length > 0 ? 'Switch' : 'Connect'}
      </button>
      {live.length > 0 && (
        <button
          className="connect-btn ghost"
          disabled={busy}
          onClick={() => void run(disconnectSession)}
        >
          Disconnect
        </button>
      )}
      <span className={`connect-state ${connected ? 'on' : ''}`}>
        {live.length > 0
          ? `${connected ? 'listening to' : 'connecting to'} ${live
              .map((c) => `${c.platform}/${c.channel}`)
              .join(' + ')}`
          : 'not connected'}
      </span>
    </div>
  );
}

function TuningCard({ settings }: { settings: EngineSettings | null }): JSX.Element {
  const [threshold, setThreshold] = useState(0.5);
  const [pace, setPace] = useState<ChatPace>('live');
  const [intervalSec, setIntervalSec] = useState(15);
  const [keywords, setKeywords] = useState('');
  const [routing, setRouting] = useState<RoutingMatrix>({});
  const [aiSummaries, setAiSummaries] = useState(true);
  const [aiPriorities, setAiPriorities] = useState(true);
  const [moderation, setModeration] = useState(true);
  const [sensitivity, setSensitivity] = useState(0.5);
  const [retentionDays, setRetentionDays] = useState(30);
  const [storeText, setStoreText] = useState(true);
  const [branding, setBranding] = useState<Branding>({
    name: '',
    accentColor: '#7c5cff',
    logoUrl: '',
  });
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const kwFocused = useRef(false);

  useEffect(() => {
    if (!settings) return;
    setThreshold(settings.surfaceThreshold);
    setPace(settings.pace);
    setIntervalSec(Math.round(settings.summaryIntervalMs / 1000));
    setRouting(settings.routing);
    setAiSummaries(settings.aiSummaries);
    setAiPriorities(settings.aiPriorities);
    setModeration(settings.moderation);
    setSensitivity(settings.moderationSensitivity);
    setRetentionDays(settings.retentionDays);
    setStoreText(settings.storeMessageText);
    setBranding(settings.branding);
    if (!kwFocused.current) setKeywords(settings.keywords.join(', '));
  }, [settings]);

  const push = (patch: Partial<EngineSettings>): void => {
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => void updateSettings(patch), 250);
  };
  const updateBranding = (patch: Partial<Branding>): void => {
    setBranding((prev) => {
      const next = { ...prev, ...patch };
      push({ branding: next });
      return next;
    });
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
        <div className="tune-row">
          <span>Chat pace</span>
          <div style={{ display: 'flex', gap: 6 }}>
            {(['live', 'balanced', 'calm'] as const).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => {
                  setPace(p);
                  push({ pace: p });
                }}
                style={{
                  flex: 1,
                  padding: '6px 10px',
                  borderRadius: 8,
                  border: `1px solid ${pace === p ? '#7c5cff' : '#33333d'}`,
                  background: pace === p ? '#7c5cff22' : 'transparent',
                  color: '#e8e8f0',
                  fontSize: 13,
                  cursor: 'pointer',
                  textTransform: 'capitalize',
                }}
              >
                {p}
              </button>
            ))}
          </div>
        </div>
        <p style={{ margin: '-4px 0 4px', fontSize: 11, opacity: 0.55 }}>
          Live = real-time · Balanced ≈ 20/min · Calm ≈ 8/min. Donations and big moments always
          show.
        </p>
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
              <span>feel</span>
            </div>
            {ROUTABLE.map((cat) => (
              <div className="routing-row" key={cat}>
                <span className="routing-cat">{cat}</span>
                {(['display', 'voice', 'earcon', 'haptic'] as const).map((ch) => (
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

        <label className="tune-row">
          <span>
            Overlay branding <span className="hint-sm">Pro</span>
          </span>
          <input
            className="tune-input"
            type="text"
            value={branding.name}
            placeholder="Brand name shown on the overlay"
            onChange={(e) => updateBranding({ name: e.target.value })}
          />
        </label>
        <div className="tune-row">
          <span>Accent color</span>
          <input
            type="color"
            value={branding.accentColor}
            onChange={(e) => updateBranding({ accentColor: e.target.value })}
          />
        </div>
        <label className="tune-row">
          <span>Logo URL (https)</span>
          <input
            className="tune-input"
            type="text"
            value={branding.logoUrl}
            placeholder="https://…/logo.png"
            onChange={(e) => updateBranding({ logoUrl: e.target.value })}
          />
        </label>
      </div>
    </Card>
  );
}

function AccountCard(): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [pairLinks, setPairLinks] = useState<{ hud: string; companion: string } | null>(null);
  const [pairing, setPairing] = useState(false);
  const generatePair = async (): Promise<void> => {
    setPairing(true);
    try {
      const [hud, companion] = await Promise.all([
        requestPairLink(HUD_URL),
        requestPairLink(COMPANION_URL),
      ]);
      setPairLinks({ hud, companion });
    } finally {
      setPairing(false);
    }
  };
  const go = async (fn: () => Promise<string | null>): Promise<void> => {
    setBusy(true);
    try {
      const url = await fn();
      if (url) window.location.href = url;
      else setBusy(false);
    } catch {
      setBusy(false);
    }
  };
  const link = (provider: 'twitch' | 'youtube' | 'kick'): void => {
    void oauthStartUrl(provider).then((url) => {
      window.location.href = url;
    });
  };
  return (
    <Card title="Account & plan">
      <div className="list-label">Link your channel</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
        <button type="button" className="connect-btn ghost" onClick={() => link('twitch')}>
          Twitch
        </button>
        <button type="button" className="connect-btn ghost" onClick={() => link('youtube')}>
          YouTube
        </button>
        <button type="button" className="connect-btn ghost" onClick={() => link('kick')}>
          Kick
        </button>
      </div>
      <p className="hint-sm">Linking enables live chat reading instead of anonymous mode.</p>

      <div className="list-label" style={{ marginTop: 12 }}>
        Plan
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
        <button
          type="button"
          className="connect-btn"
          disabled={busy}
          onClick={() => void go(() => startCheckout('creator'))}
        >
          Creator · £{PLANS.creator.priceMonthlyGbp}/mo
        </button>
        <button
          type="button"
          className="connect-btn"
          disabled={busy}
          onClick={() => void go(() => startCheckout('pro'))}
        >
          Pro · £{PLANS.pro.priceMonthlyGbp}/mo
        </button>
        <button
          type="button"
          className="connect-btn ghost"
          disabled={busy}
          onClick={() => void go(openBillingPortal)}
        >
          Manage
        </button>
      </div>

      <div className="list-label" style={{ marginTop: 12 }}>
        Pair a device
      </div>
      <button
        type="button"
        className="connect-btn ghost"
        disabled={pairing}
        onClick={() => void generatePair()}
      >
        {pairing ? 'Generating…' : 'Generate pairing links'}
      </button>
      {pairLinks ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
          <a className="pair-link" href={pairLinks.hud} target="_blank" rel="noopener noreferrer">
            Open HUD overlay →
          </a>
          <input
            className="pair-input"
            readOnly
            value={pairLinks.companion}
            onFocus={(e) => e.currentTarget.select()}
            aria-label="Companion pairing link"
          />
          <p className="hint-sm">
            Single-use links (valid ~5 min). Open the HUD here; paste the companion link on your
            phone.
          </p>
        </div>
      ) : null}
    </Card>
  );
}

function TeamCard(): JSX.Element {
  const [members, setMembers] = useState<TeamMember[] | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'admin' | 'member'>('member');
  const [note, setNote] = useState('');
  const [token, setToken] = useState('');

  const refresh = (): void => {
    void listTeam().then((m) => {
      setMembers(m);
      setLoaded(true);
    });
  };
  useEffect(refresh, []);

  // The roster endpoint 403s (→ null) on plans without team management.
  if (loaded && members === null) {
    return (
      <Card title="Team">
        <p className="hint-sm">
          Team seats are part of the Pro plan — upgrade to invite teammates.
        </p>
      </Card>
    );
  }

  const invite = async (): Promise<void> => {
    setNote('');
    const res = await inviteMember(email.trim(), role);
    if ('error' in res) setNote(res.error);
    else {
      setEmail('');
      refresh();
    }
  };
  const makeLogin = async (id: string): Promise<void> => {
    setToken(
      (await memberLoginToken(id)) ?? 'Member logins require GLANCE_AUTH_SECRET on the server.',
    );
  };
  const list = members ?? [];

  return (
    <Card title="Team">
      {list.length === 0 ? (
        <p className="hint-sm">No teammates yet — invite someone to share this account.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {list.map((m) => (
            <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {m.email}
              </span>
              <span style={{ opacity: 0.6, textTransform: 'capitalize' }}>{m.role}</span>
              <span style={{ opacity: 0.4 }}>{m.status}</span>
              <button
                type="button"
                className="connect-btn ghost"
                onClick={() => void makeLogin(m.id)}
              >
                Login link
              </button>
              <button
                type="button"
                aria-label="Remove teammate"
                onClick={() => void removeMember(m.id).then(refresh)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#9a9aa6',
                  cursor: 'pointer',
                  fontSize: 16,
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
        <input
          className="connect-input"
          style={{ flex: 1 }}
          value={email}
          placeholder="teammate@email.com"
          spellCheck={false}
          onChange={(e) => setEmail(e.target.value)}
        />
        <select
          className="connect-platform"
          value={role}
          aria-label="Role"
          onChange={(e) => setRole(e.target.value as 'admin' | 'member')}
        >
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </select>
        <button type="button" className="connect-btn" onClick={() => void invite()}>
          Invite
        </button>
      </div>
      {note && (
        <p className="hint-sm" style={{ color: '#ff8fab' }}>
          {note}
        </p>
      )}
      {token && (
        <div style={{ marginTop: 8 }}>
          <div className="list-label">Login token — share with the teammate</div>
          <input
            className="connect-input"
            readOnly
            value={token}
            onFocus={(e) => e.currentTarget.select()}
            style={{ width: '100%', marginTop: 4, fontSize: 12 }}
          />
        </div>
      )}
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
