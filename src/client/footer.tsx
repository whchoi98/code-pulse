import { useEffect, useId, useRef, useState } from 'react';
import { Info } from 'lucide-react';
import appRelease from '../shared/app-release.json';
import { Modal } from './components';
import { displayDate, displayTimestamp } from './lib';
import { usePresence } from './presence';

export function PresenceCounter() {
  const { snapshot, status } = usePresence();
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const tooltipId = useId();
  const active = snapshot?.active_visitors.toLocaleString('ko-KR');
  const total = snapshot?.total_visitors.toLocaleString('ko-KR');
  const label = snapshot
    ? `${status === 'stale' ? '마지막 확인값, ' : ''}접속 ${active}, 누적 방문 ${total}. 집계 기준 보기`
    : `${status === 'loading' ? '접속 집계 확인 중' : '접속 집계 확인 불가'}. 집계 기준 보기`;

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  return <div ref={wrapper} className="presence-wrap" data-presence-state={status}
    onPointerEnter={() => setOpen(true)}
    onPointerLeave={() => { if (!wrapper.current?.contains(document.activeElement)) setOpen(false); }}>
    <button className="presence-counter" aria-label={label} aria-describedby={tooltipId}
      onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} onClick={() => setOpen(true)}>
      <span className="presence-summary" role="status" aria-label="방문 집계" aria-live="polite" aria-atomic="true">
        {snapshot ? <>
          {status === 'stale' && <span className="presence-last">마지막 확인</span>}
          <span className="presence-metric">접속 <strong>{active}</strong></span>
          <span className="presence-metric">누적 방문 <strong>{total}</strong></span>
        </> : <span>{status === 'loading' ? '접속 집계 확인 중' : '접속 집계 확인 불가'}</span>}
      </span>
      <Info size={13} aria-hidden="true" />
    </button>
    <div className="presence-tooltip" id={tooltipId} role="tooltip" hidden={!open}>
      <p>접속은 최근 {snapshot?.window_seconds ?? 90}초 동안 접속 신호를 보낸 브라우저 수입니다. 누적 방문은 집계 시작 이후 방문한 브라우저를 셉니다.</p>
      <p>같은 브라우저의 새로고침과 여러 탭은 중복 집계하지 않습니다. 실제 사람 수와 다를 수 있습니다. 화면이 보이고 온라인일 때 30초마다 갱신합니다.</p>
      {snapshot && <p>마지막 확인: {displayTimestamp(snapshot.as_of)} (한국 시간)</p>}
      <p>집계 시작: {snapshot?.counting_since ? `${displayTimestamp(snapshot.counting_since)} (한국 시간)` : '아직 확인하지 못했습니다.'}</p>
    </div>
  </div>;
}

export function ServiceReleaseDialog({ onClose }: { onClose: () => void }) {
  return <Modal title="Code Pulse 변경 기록" onClose={onClose} className="service-release-modal">
    <p className="modal-intro">Code Pulse에 추가한 기능과 수정한 내용을 확인하세요.</p>
    <div className="service-release-list">
      {appRelease.releases.map(release => <section className="service-release" key={release.version}>
        <div className="service-release-heading">
          <h3>v{release.version}</h3>
          {release.version === __APP_VERSION__ && <span className="current-release">현재 버전</span>}
          <time dateTime={release.date}>{displayDate(release.date)}</time>
        </div>
        <ul>{release.changes.map((change, index) => <li key={`${release.version}-${index}`}>{change.ko}</li>)}</ul>
      </section>)}
    </div>
  </Modal>;
}
