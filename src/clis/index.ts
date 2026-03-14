/**
 * Import all TypeScript CLI adapters so they self-register.
 *
 * Each TS adapter calls cli() on import, which adds itself to the global registry.
 */

// bilibili
import './bilibili/search.js';
import './bilibili/me.js';
import './bilibili/favorite.js';
import './bilibili/history.js';
import './bilibili/feed.js';
import './bilibili/user-videos.js';

// github
import './github/search.js';

// zhihu
import './zhihu/question.js';

// xiaohongshu
import './xiaohongshu/search.js';
