import { useCallback, useEffect, useState } from 'react';
import type { SessionDetail, SessionSummary, TimelineEntry } from '@glance/core';
import { deleteReplay, getReplay, listSessions } from './api';

export function ReplayView(): JSX.Element {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const list = await listSessions();
    setSessions(list);
    setLoading(false);
    setSelectedId((cur) => cur ?? list[0]?.id ?? null);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    void getReplay(selectedId).then(setDetail);
  }, [selectedId]);

  const onDelete = async (id: string): Promise<void> => {
    await deleteReplay(id);
    setSelectedId((cur) => (cur === id ? null : cur));
    await refresh();
  };

  if (loading) return <div className="cc-empty">Loading sessions…</div>;
  if (sessions.length === 0) {
    return (
      <div className="cc-empty">
        No archived sessions yet. Go live, then Disconnect (or switch channels) to archive one.
      </div>
    );
  }

  return (
    <div className="replay">
      <div className="replay-list">
        {sessions.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`replay-item ${selectedId === s.id ? 'on' : ''}`}
            onClick={() => setSelectedId(s.id)}
          >
            <div className="replay-item-top">
              <span className="replay-ch">#{s.channel}</span>
              <span className="replay-when">{formatDate(s.startedAt)}</span>
            </div>
            <div className="replay-item-meta">
              {formatDuration(s.durationSec)} · {s.messages} msgs · {s.bits} bits
            </div>
            {s.recapHeadline && <div className="replay-item-recap">{s.recapHeadline}</div>}
          </button>
        ))}
      </div>

      <div className="replay-detail">
        {detail ? (
          <ReplayDetail detail={detail} onDelete={() => void onDelete(detail.id)} />
        ) : (
          <p className="muted">Select a session to replay.</p>
        )}
      </div>
    </div>
  );
}

function ReplayDetail({
  detail,
  onDelete,
}: {
  detail: SessionDetail;
  onDelete: () => void;
}): JSX.Element {
  return (
    <div className="rd">
      <div className="rd-head">
        <div>
          <h2 className="rd-title">#{detail.channel}</h2>
          <div className="rd-sub">
            {formatDate(detail.startedAt)} · {formatDuration(detail.durationSec)}
          </div>
        </div>
        <button type="button" className="rd-del" onClick={onDelete}>
          Delete
        </button>
      </div>

      <div className="rd-stats">
        <Metric label="Messages" value={detail.messages} />
        <Metric label="Bits" value={detail.bits} />
        <Metric label="Events" value={detail.events} />
        <Metric label="Peak chatters" value={detail.peakChatters} />
      </div>

      {detail.recap && (
        <div className="rd-recap">
          <span className="tag">{detail.recap.source === 'ai' ? 'Claude recap' : 'Recap'}</span>
          <p className="rd-recap-text">{detail.recap.headline}</p>
        </div>
      )}

      <h3 className="rd-h3">Best moments</h3>
      <div className="rd-moments">
        {detail.moments.length === 0 ? (
          <p className="muted">No standout moments.</p>
        ) : (
          detail.moments.map((m) => (
            <div className="rd-moment" key={m.id}>
              <span className="rd-score">{Math.round(m.score * 100)}</span>
              <div className="rd-moment-body">
                <span className="rd-author">{m.author}</span>
                <span className="rd-text">{m.text}</span>
              </div>
            </div>
          ))
        )}
      </div>

      <h3 className="rd-h3">Timeline</h3>
      <div className="rd-timeline">
        {detail.timeline.length === 0 ? (
          <p className="muted">Quiet session.</p>
        ) : (
          [...detail.timeline]
            .reverse()
            .slice(0, 40)
            .map((entry, i) => <TimelineRow key={i} entry={entry} />)
        )}
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }): JSX.Element {
  return (
    <div className="rd-metric">
      <div className="rd-metric-v">{value}</div>
      <div className="rd-metric-l">{label}</div>
    </div>
  );
}

function TimelineRow({ entry }: { entry: TimelineEntry }): JSX.Element {
  const at = formatDuration(entry.atSec);
  if (entry.kind === 'donation') {
    return (
      <div className="tl">
        <span className="tl-at">{at}</span>
        <span className="tl-dot gold" />
        {entry.author} cheered {entry.bits} bits
      </div>
    );
  }
  if (entry.kind === 'event') {
    return (
      <div className="tl">
        <span className="tl-at">{at}</span>
        <span className="tl-dot gold" />
        {entry.summary}
      </div>
    );
  }
  if (entry.kind === 'marker') {
    return (
      <div className="tl">
        <span className="tl-at">{at}</span>
        <span className="tl-dot" style={{ background: '#7c5cff' }} />★ {entry.label}
      </div>
    );
  }
  return (
    <div className="tl">
      <span className="tl-at">{at}</span>
      <span className="tl-dot indigo" />
      {entry.headline}
    </div>
  );
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
