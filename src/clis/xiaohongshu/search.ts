/**
 * Xiaohongshu search — trigger search via Pinia store + XHR interception.
 * Inspired by bb-sites/xiaohongshu/search.js but adapted for opencli pipeline.
 */

import { cli, Strategy } from '../../registry.js';

cli({
  site: 'xiaohongshu',
  name: 'search',
  description: '搜索小红书笔记',
  domain: 'www.xiaohongshu.com',
  strategy: Strategy.COOKIE,
  args: [
    { name: 'keyword', required: true, help: 'Search keyword' },
    { name: 'limit', type: 'int', default: 20, help: 'Number of results' },
  ],
  columns: ['rank', 'title', 'author', 'likes', 'type'],
  func: async (page, kwargs) => {
    await page.goto('https://www.xiaohongshu.com');
    await page.wait(2);

    const data = await page.evaluate(`
      (async () => {
        const app = document.querySelector('#app')?.__vue_app__;
        const pinia = app?.config?.globalProperties?.$pinia;
        if (!pinia?._s) return {error: 'Page not ready'};

        const searchStore = pinia._s.get('search');
        if (!searchStore) return {error: 'Search store not found'};

        let captured = null;
        const origOpen = XMLHttpRequest.prototype.open;
        const origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function(m, u) { this.__url = u; return origOpen.apply(this, arguments); };
        XMLHttpRequest.prototype.send = function(b) {
          if (this.__url?.includes('search/notes')) {
            const x = this;
            const orig = x.onreadystatechange;
            x.onreadystatechange = function() { if (x.readyState === 4 && !captured) { try { captured = JSON.parse(x.responseText); } catch {} } if (orig) orig.apply(this, arguments); };
          }
          return origSend.apply(this, arguments);
        };

        try {
          searchStore.mutateSearchValue('${kwargs.keyword}');
          await searchStore.loadMore();
          await new Promise(r => setTimeout(r, 800));
        } finally {
          XMLHttpRequest.prototype.open = origOpen;
          XMLHttpRequest.prototype.send = origSend;
        }

        if (!captured?.success) return {error: captured?.msg || 'Search failed'};
        return (captured.data?.items || []).map(i => ({
          title: i.note_card?.display_title || '',
          type: i.note_card?.type || '',
          url: 'https://www.xiaohongshu.com/explore/' + i.id,
          author: i.note_card?.user?.nickname || '',
          likes: i.note_card?.interact_info?.liked_count || '0',
        }));
      })()
    `);

    if (!Array.isArray(data)) return [];
    return data.slice(0, kwargs.limit).map((item: any, i: number) => ({
      rank: i + 1,
      ...item,
    }));
  },
});
