import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { remoteCache, seedBootstrapFromDocument } from './remote-cache';
import { getInitialLanguage } from './i18n';
import './styles.css';

const bootstrap = seedBootstrapFromDocument(document);
const language = getInitialLanguage();
const render = () => ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /></React.StrictMode>,
);
// A saved preference can differ from the server's default language. Keep the
// existing rendered page visible until its selected-language content is ready.
if (bootstrap && bootstrap.language !== language) {
  const prepare = async () => {
    const feed = await remoteCache.loadFeed(language);
    const entry = new URLSearchParams(window.location.search).get('entry');
    if (entry) await remoteCache.loadDetail(entry, feed, language);
  };
  void prepare().then(render, render);
}
else render();
