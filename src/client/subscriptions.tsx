import { useRef, useState } from 'react';
import { Copy, ExternalLink } from 'lucide-react';
import { PRODUCT_IDS, type ProductId } from '../shared/types';
import { Modal } from './components';
import { products } from './lib';
import { useLocale } from './i18n';

export function SubscriptionDialog({ product, onClose }: { product: ProductId | 'all'; onClose: () => void }) {
  const { language, t } = useLocale();
  const [selected, setSelected] = useState(product);
  const [notice, setNotice] = useState<'copied' | 'failed' | null>(null);
  const addressInput = useRef<HTMLInputElement>(null);
  const feedUrl = new URL('/feed.xml', window.location.origin);
  if (selected !== 'all') feedUrl.searchParams.set('product', selected);
  if (language === 'en') feedUrl.searchParams.set('lang', language);
  const address = feedUrl.href;

  const copyAddress = async () => {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(address);
      setNotice('copied');
    } catch {
      setNotice('failed');
      addressInput.current?.focus();
      addressInput.current?.select();
    }
  };

  return <Modal title={t('RSS 구독', 'Subscribe via RSS')} onClose={onClose} className="subscription-modal">
    <p className="modal-intro">{t('구독 주소를 RSS 리더에 추가하면 새 글을 받아볼 수 있습니다. 한국어 해설이 준비된 최신 글을 최대 50개 제공합니다.',
      'Add this feed URL to your RSS reader for new articles. The English feed includes up to 50 recent articles with official source text.')}</p>
    <div className="subscription-product">
      <label htmlFor="subscription-product">{t('구독할 제품', 'Product to follow')}</label>
      <select id="subscription-product" value={selected} onChange={event => { setSelected(event.target.value as ProductId | 'all'); setNotice(null); }}>
        <option value="all">{t('모든 제품', 'All products')}</option>
        {PRODUCT_IDS.map(id => <option key={id} value={id}>{products[id].name}</option>)}
      </select>
    </div>
    <label className="share-label subscription-address">{t('구독 주소', 'Feed URL')}
      <input ref={addressInput} readOnly value={address} onFocus={event => event.target.select()} spellCheck={false} />
    </label>
    <div className="subscription-actions">
      <button className="primary-button" onClick={() => void copyAddress()}><Copy size={15} aria-hidden="true" />{t('구독 주소 복사', 'Copy feed URL')}</button>
      <a className="secondary-button" href={address} target="_blank" rel="noopener noreferrer">{t('RSS 피드 열기', 'Open RSS feed')}<ExternalLink size={14} aria-hidden="true" /></a>
    </div>
    <p className="subscription-notice" role="status" aria-live="polite" aria-atomic="true">{notice === 'copied'
      ? t('구독 주소를 복사했습니다.', 'Feed URL copied.')
      : notice === 'failed' ? t('주소를 복사하지 못했습니다. 구독 주소를 선택해 직접 복사하세요.', 'Could not copy the URL. Select the feed URL and copy it manually.') : ''}</p>
  </Modal>;
}
