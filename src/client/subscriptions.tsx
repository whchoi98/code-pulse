import { useRef, useState } from 'react';
import { Copy, ExternalLink } from 'lucide-react';
import { PRODUCT_IDS, type ProductId } from '../shared/types';
import { Modal } from './components';
import { products } from './lib';

export function SubscriptionDialog({ product, onClose }: { product: ProductId | 'all'; onClose: () => void }) {
  const [selected, setSelected] = useState(product);
  const [notice, setNotice] = useState('');
  const addressInput = useRef<HTMLInputElement>(null);
  const address = new URL(`/feed.xml${selected === 'all' ? '' : `?product=${selected}`}`, window.location.origin).href;

  const copyAddress = async () => {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(address);
      setNotice('구독 주소를 복사했습니다.');
    } catch {
      setNotice('주소를 복사하지 못했습니다. 구독 주소를 선택해 직접 복사하세요.');
      addressInput.current?.focus();
      addressInput.current?.select();
    }
  };

  return <Modal title="RSS 구독" onClose={onClose} className="subscription-modal">
    <p className="modal-intro">구독 주소를 RSS 리더에 추가하면 새 글을 받아볼 수 있습니다. 한국어 해설이 준비된 최신 글을 최대 50개 제공합니다.</p>
    <div className="subscription-product">
      <label htmlFor="subscription-product">구독할 제품</label>
      <select id="subscription-product" value={selected} onChange={event => { setSelected(event.target.value as ProductId | 'all'); setNotice(''); }}>
        <option value="all">모든 제품</option>
        {PRODUCT_IDS.map(id => <option key={id} value={id}>{products[id].name}</option>)}
      </select>
    </div>
    <label className="share-label subscription-address">구독 주소
      <input ref={addressInput} readOnly value={address} onFocus={event => event.target.select()} spellCheck={false} />
    </label>
    <div className="subscription-actions">
      <button className="primary-button" onClick={() => void copyAddress()}><Copy size={15} aria-hidden="true" />구독 주소 복사</button>
      <a className="secondary-button" href={address} target="_blank" rel="noopener noreferrer">RSS 피드 열기<ExternalLink size={14} aria-hidden="true" /></a>
    </div>
    <p className="subscription-notice" role="status" aria-live="polite" aria-atomic="true">{notice}</p>
  </Modal>;
}
