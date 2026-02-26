/**
 * channelService — fetches videos from curated YouTube channels.
 *
 * Strategy (zero API quota for normal use):
 *   1. Channel IDs are hardcoded → no channels.list call ever needed.
 *   2. YouTube RSS feeds via Netlify proxy → no API key, no quota, instant.
 *      Returns the 15 most recent videos per channel (60 total across 4 channels).
 *   3. When the pool runs low, playlistItems.list extends it (1 quota unit
 *      per 50 videos). Silently skipped if the API key is restricted.
 */
import { CONFIG } from '../config.js';

const CHANNELS = [
    { handle: 'VinyleArcheologie',            channelId: 'UCKydEBEvAU5zkN8o1snt62A' },
    { handle: 'oleg_samples',                  channelId: 'UC47qc6t2RelhfvI-OjgIY2A' },
    { handle: 'librariessountracksandrelated', channelId: 'UCekevJPGTZ44nn_i4SWJDIw' },
    { handle: 'andrenavarroII',                channelId: 'UCv5OAW45h67CJEY6kJLyisg' },
];

// Uploads playlist ID = 'UU' + channelId.slice(2)
const uploadsId = ch => 'UU' + ch.channelId.slice(2);

const cache = {};          // handle → { videos, nextPageToken, rssLoaded, loading }
const seenVideos = new Set();

// ─── RSS ──────────────────────────────────────────────────────────────────────

async function fetchRss(channelId) {
    const res = await fetch(`/api/yt-rss/${channelId}`);
    if (!res.ok) throw new Error(`RSS ${res.status}`);
    return parseRss(await res.text());
}

function parseRss(xml) {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.querySelector('parsererror')) return [];
    const channelTitle = doc.querySelector('author name')?.textContent || '';
    return Array.from(doc.querySelectorAll('entry')).map(entry => {
        const idText = entry.querySelector('id')?.textContent || '';
        const videoId = idText.startsWith('yt:video:') ? idText.slice(9) : null;
        if (!videoId) return null;
        return {
            contentDetails: { videoId },
            snippet: {
                title:        entry.querySelector('title')?.textContent || '',
                publishedAt:  entry.querySelector('published')?.textContent || '',
                channelTitle,
                thumbnails: { high: { url: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` } },
            },
        };
    }).filter(Boolean);
}

// ─── YouTube Data API (optional, for deeper pagination only) ──────────────────

async function ytFetch(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`YT API ${res.status}`);
    return res.json();
}

async function loadPlaylistPage(ch) {
    const pid = uploadsId(ch);
    let url = `${CONFIG.YOUTUBE_BASE_URL}/playlistItems?part=snippet,contentDetails&playlistId=${pid}&maxResults=50&key=${CONFIG.YOUTUBE_API_KEY}`;
    const state = cache[ch.handle];
    if (state.nextPageToken) url += `&pageToken=${state.nextPageToken}`;
    const data = await ytFetch(url);
    const items = (data.items || []).filter(item => {
        const vid = item.contentDetails?.videoId;
        const title = item.snippet?.title;
        return vid && title !== 'Deleted video' && title !== 'Private video';
    });
    state.videos.push(...items);
    state.nextPageToken = data.nextPageToken ?? null;
}

// ─── Main load function ───────────────────────────────────────────────────────

function _ensureCache(handle) {
    if (!cache[handle]) cache[handle] = { videos: [], nextPageToken: undefined, rssLoaded: false, loading: false };
}

async function loadMoreVideos(ch) {
    _ensureCache(ch.handle);
    const state = cache[ch.handle];
    if (state.loading) return;
    state.loading = true;
    try {
        // Phase 1: RSS (no API key, no quota) — runs once per channel
        if (!state.rssLoaded) {
            state.rssLoaded = true;
            const items = await fetchRss(ch.channelId);
            if (items.length) { state.videos.push(...items); return; }
        }
        // Phase 2: playlistItems API for further pages (silently skipped on error)
        if (state.nextPageToken !== null) {
            await loadPlaylistPage(ch);
        }
    } finally {
        state.loading = false;
    }
}

// ─── Title parser ─────────────────────────────────────────────────────────────

function parseTitle(raw) {
    const m = raw.match(/^(.+?)\s[–—-]\s(.+)$/);
    if (m) return { artist: m[1].trim(), title: m[2].trim().replace(/\s*[\(\[]\d{4}[\)\]]\s*$/, '').trim() };
    return { artist: '', title: raw };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export const channelService = {
    async init() {
        await Promise.all(
            CHANNELS.map(ch => loadMoreVideos(ch).catch(err =>
                console.warn(`[channelService] init failed for ${ch.handle}:`, err.message)
            ))
        );
    },

    hasAnyVideos() {
        return CHANNELS.some(ch => (cache[ch.handle]?.videos?.length ?? 0) > 0);
    },

    async fetchRandomVideo() {
        const ch = CHANNELS[Math.floor(Math.random() * CHANNELS.length)];
        _ensureCache(ch.handle);

        if (!cache[ch.handle].videos.length) {
            try { await loadMoreVideos(ch); }
            catch (err) { console.warn(`[channelService] load failed for ${ch.handle}:`, err.message); return null; }
        }

        const pool = cache[ch.handle].videos;
        if (!pool.length) return null;

        const unseen = pool.filter(v => !seenVideos.has(v.contentDetails.videoId));
        const candidates = unseen.length ? unseen : pool;
        const item = candidates[Math.floor(Math.random() * candidates.length)];
        const videoId = item.contentDetails.videoId;

        seenVideos.add(videoId);
        if (seenVideos.size > 500) seenVideos.delete(seenVideos.values().next().value);

        // Silently extend pool in background when running low
        if ((pool.length - seenVideos.size) < 20) loadMoreVideos(ch).catch(() => {});

        const snippet = item.snippet || {};
        const { artist, title } = parseTitle(snippet.title || '');
        const q = encodeURIComponent([artist, title].filter(Boolean).join(' '));

        return {
            releaseId:         videoId,
            title:             title || snippet.title || '',
            artist:            artist || snippet.channelTitle || ch.handle,
            year:              (snippet.publishedAt || '').slice(0, 4),
            category:          snippet.channelTitle || ch.handle,
            coverUrl:          snippet.thumbnails?.high?.url || '',
            discogsUrl:        `https://www.discogs.com/search/?q=${q}&type=release`,
            youtubeVideoIds:   [videoId],
            youtubePlaylistId: null,
            trackList:         [],
            isChannelMode:     true,
        };
    },

    clearSession() { seenVideos.clear(); },
};
