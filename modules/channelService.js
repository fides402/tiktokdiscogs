/**
 * channelService — fetches videos from curated YouTube channels.
 *
 * Strategy (quota-free first, API only as last resort):
 *   1. YouTube RSS feed via Netlify proxy  — 0 quota, 0 API key
 *      • /api/yt-rss-user/:handle   (legacy username, works for most channels)
 *      • /api/yt-rss/:channelId     (by channel ID, needs step 2)
 *   2. channels.list?forHandle=     — 1 quota unit, result cached in
 *      localStorage forever → subsequent sessions cost 0 units
 *   3. playlistItems.list           — 1 unit per 50 videos, used to extend
 *      the pool beyond the 15-video RSS limit (optional, silently skipped
 *      if quota is exceeded)
 */
import { CONFIG } from '../config.js';

const CHANNEL_HANDLES = [
    'VinyleArcheologie',
    'oleg_samples',
    'librariessountracksandrelated',
    'andrenavarroII',
];

const LS_PREFIX = 'ag_yt_ch_';   // localStorage key prefix for channel IDs
const cache = {};                  // in-memory per-channel state
const seenVideos = new Set();

// ─── RSS helpers ──────────────────────────────────────────────────────────────

async function fetchRss(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`RSS ${res.status}`);
    return parseRssXml(await res.text());
}

function parseRssXml(xml) {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.querySelector('parsererror')) return [];
    const channelTitle = doc.querySelector('author name')?.textContent || '';
    return Array.from(doc.querySelectorAll('entry')).map(entry => {
        // <id>yt:video:VIDEO_ID</id>
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

// ─── YouTube Data API helpers ─────────────────────────────────────────────────

async function ytFetch(url) {
    const res = await fetch(url);
    if (!res.ok) {
        let reason = '';
        try { reason = JSON.parse(await res.text())?.error?.errors?.[0]?.reason || ''; } catch (_) {}
        throw new Error(`YouTube API ${res.status}${reason ? ' (' + reason + ')' : ''}`);
    }
    return res.json();
}

/** Returns the YouTube channel ID, or null if unavailable. Cached in localStorage. */
async function resolveChannelId(handle) {
    if (cache[handle]?.channelId) return cache[handle].channelId;
    const stored = localStorage.getItem(LS_PREFIX + handle);
    if (stored) { _ensureCache(handle); cache[handle].channelId = stored; return stored; }

    for (const h of ['@' + handle, handle]) {
        try {
            const data = await ytFetch(
                `${CONFIG.YOUTUBE_BASE_URL}/channels?part=id&forHandle=${encodeURIComponent(h)}&key=${CONFIG.YOUTUBE_API_KEY}`
            );
            const id = data.items?.[0]?.id;
            if (id) {
                localStorage.setItem(LS_PREFIX + handle, id);
                _ensureCache(handle);
                cache[handle].channelId = id;
                return id;
            }
        } catch (e) {
            console.warn(`[channelService] channels.list forHandle(${h}) failed:`, e.message);
        }
    }
    return null; // Not critical — RSS-by-username may still work
}

// ─── Per-channel cache ────────────────────────────────────────────────────────

function _ensureCache(handle) {
    if (!cache[handle]) {
        cache[handle] = { channelId: null, uploadsPlaylistId: null, videos: [], nextPageToken: undefined, rssLoaded: false, loading: false };
    }
}

// ─── Load videos ──────────────────────────────────────────────────────────────

async function loadMoreVideos(handle) {
    _ensureCache(handle);
    const ch = cache[handle];
    if (ch.loading) return;
    ch.loading = true;
    try {
        // ── Phase 1: RSS (free, no quota) ─────────────────────────────────────
        if (!ch.rssLoaded) {
            let items = [];

            // Try RSS by legacy username first (most common, 0 quota)
            try {
                items = await fetchRss(`/api/yt-rss-user/${encodeURIComponent(handle)}`);
            } catch (_) { /* try channel_id next */ }

            // If empty, try by channel ID (resolve it via API if needed — 1 quota unit, cached)
            if (!items.length) {
                const channelId = await resolveChannelId(handle);
                if (channelId) {
                    try {
                        items = await fetchRss(`/api/yt-rss/${encodeURIComponent(channelId)}`);
                    } catch (_) { /* give up on RSS */ }
                }
            }

            ch.rssLoaded = true;
            if (items.length) {
                ch.videos.push(...items);
                return; // RSS succeeded — done for now
            }
        }

        // ── Phase 2: playlistItems API (1 unit / 50 videos) ───────────────────
        // Only attempted after RSS phase, and silently skipped on quota errors.
        if (ch.nextPageToken === null) return; // playlist exhausted

        const channelId = await resolveChannelId(handle);
        if (!channelId) return;

        // Get uploads playlist ID
        if (!ch.uploadsPlaylistId) {
            const data = await ytFetch(
                `${CONFIG.YOUTUBE_BASE_URL}/channels?part=contentDetails&id=${channelId}&key=${CONFIG.YOUTUBE_API_KEY}`
            );
            ch.uploadsPlaylistId = data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads ?? null;
            if (!ch.uploadsPlaylistId) return;
        }

        let url = `${CONFIG.YOUTUBE_BASE_URL}/playlistItems?part=snippet,contentDetails&playlistId=${ch.uploadsPlaylistId}&maxResults=50&key=${CONFIG.YOUTUBE_API_KEY}`;
        if (ch.nextPageToken) url += `&pageToken=${ch.nextPageToken}`;

        const data = await ytFetch(url);
        const items = (data.items || []).filter(item => {
            const vid = item.contentDetails?.videoId;
            const title = item.snippet?.title;
            return vid && title !== 'Deleted video' && title !== 'Private video';
        });
        ch.videos.push(...items);
        ch.nextPageToken = data.nextPageToken ?? null;

    } finally {
        ch.loading = false;
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
            CHANNEL_HANDLES.map(h => loadMoreVideos(h).catch(err =>
                console.warn(`[channelService] init failed for ${h}:`, err.message)
            ))
        );
    },

    hasAnyVideos() {
        return CHANNEL_HANDLES.some(h => (cache[h]?.videos?.length ?? 0) > 0);
    },

    async fetchRandomVideo() {
        const handle = CHANNEL_HANDLES[Math.floor(Math.random() * CHANNEL_HANDLES.length)];
        _ensureCache(handle);

        if (!cache[handle].videos.length) {
            try { await loadMoreVideos(handle); }
            catch (err) {
                console.warn(`[channelService] fetchRandomVideo failed for ${handle}:`, err.message);
                return null;
            }
        }

        const pool = cache[handle].videos;
        if (!pool.length) return null;

        const unseen = pool.filter(v => !seenVideos.has(v.contentDetails.videoId));
        const candidates = unseen.length ? unseen : pool;
        const item = candidates[Math.floor(Math.random() * candidates.length)];
        const videoId = item.contentDetails.videoId;

        seenVideos.add(videoId);
        if (seenVideos.size > 500) seenVideos.delete(seenVideos.values().next().value);

        // Extend pool in background when running low
        if ((pool.length - seenVideos.size) < 20) loadMoreVideos(handle).catch(() => {});

        const snippet = item.snippet || {};
        const { artist, title } = parseTitle(snippet.title || '');
        const q = encodeURIComponent([artist, title].filter(Boolean).join(' '));

        return {
            releaseId: videoId,
            title:    title || snippet.title || '',
            artist:   artist || snippet.channelTitle || handle,
            year:     (snippet.publishedAt || '').slice(0, 4),
            category: snippet.channelTitle || handle,
            coverUrl: snippet.thumbnails?.high?.url || '',
            discogsUrl: `https://www.discogs.com/search/?q=${q}&type=release`,
            youtubeVideoIds: [videoId],
            youtubePlaylistId: null,
            trackList: [],
            isChannelMode: true,
        };
    },

    clearSession() { seenVideos.clear(); },
};
