import { CONFIG } from '../config.js';

const CHANNEL_HANDLES = [
    'VinyleArcheologie',
    'oleg_samples',
    'librariessountracksandrelated',
    'andrenavarroII',
];

// localStorage key prefix for persisting channel IDs across sessions (avoids re-paying quota)
const LS_PREFIX = 'ag_yt_ch_';

// Per-channel runtime state
const cache = {};
const seenVideos = new Set();

async function ytFetch(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`YouTube API ${res.status}`);
    return res.json();
}

// ─── Step 1: resolve channel ID ──────────────────────────────────────────────
// Priority order (cheapest first):
//   a) in-memory cache
//   b) localStorage (free, persists between sessions)
//   c) channels.list?forHandle=  (1 quota unit — fast if it works)
//   d) search.list?type=channel  (100 quota units — fallback, result cached in localStorage)
async function resolveChannelId(handle) {
    if (cache[handle]?.channelId) return cache[handle].channelId;

    const stored = localStorage.getItem(LS_PREFIX + handle);
    if (stored) {
        _ensureCache(handle);
        cache[handle].channelId = stored;
        return stored;
    }

    // Try forHandle (channels.list, ~1 quota unit)
    try {
        const data = await ytFetch(
            `${CONFIG.YOUTUBE_BASE_URL}/channels?part=id&forHandle=${encodeURIComponent(handle)}&key=${CONFIG.YOUTUBE_API_KEY}`
        );
        const id = data.items?.[0]?.id;
        if (id) return _cacheChannelId(handle, id);
    } catch (_) { /* fall through */ }

    // Fallback: search for the channel by name (100 quota units, result cached forever)
    const searchData = await ytFetch(
        `${CONFIG.YOUTUBE_BASE_URL}/search?part=snippet&q=${encodeURIComponent(handle)}&type=channel&maxResults=1&key=${CONFIG.YOUTUBE_API_KEY}`
    );
    const id = searchData.items?.[0]?.id?.channelId;
    if (!id) throw new Error(`Channel not found: ${handle}`);
    return _cacheChannelId(handle, id);
}

function _cacheChannelId(handle, id) {
    localStorage.setItem(LS_PREFIX + handle, id);
    _ensureCache(handle);
    cache[handle].channelId = id;
    return id;
}

// ─── Step 2: resolve uploads playlist ID ─────────────────────────────────────
async function resolveUploadsPlaylist(handle) {
    if (cache[handle]?.uploadsPlaylistId) return cache[handle].uploadsPlaylistId;
    const channelId = await resolveChannelId(handle);
    const data = await ytFetch(
        `${CONFIG.YOUTUBE_BASE_URL}/channels?part=contentDetails&id=${channelId}&key=${CONFIG.YOUTUBE_API_KEY}`
    );
    const uploadsId = data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploadsId) throw new Error(`No uploads playlist for channel: ${handle}`);
    cache[handle].uploadsPlaylistId = uploadsId;
    return uploadsId;
}

// ─── Step 3: paginate videos from uploads playlist ───────────────────────────
async function loadMoreVideos(handle) {
    _ensureCache(handle);
    const ch = cache[handle];
    if (ch.loading || ch.nextPageToken === null) return;
    ch.loading = true;
    try {
        const uploadsId = await resolveUploadsPlaylist(handle);
        let url = `${CONFIG.YOUTUBE_BASE_URL}/playlistItems?part=snippet,contentDetails&playlistId=${uploadsId}&maxResults=50&key=${CONFIG.YOUTUBE_API_KEY}`;
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

function _ensureCache(handle) {
    if (!cache[handle]) {
        cache[handle] = { channelId: null, uploadsPlaylistId: null, videos: [], nextPageToken: undefined, loading: false };
    }
}

// ─── Title parser ─────────────────────────────────────────────────────────────
function parseTitle(raw) {
    const match = raw.match(/^(.+?)\s[–—-]\s(.+)$/);
    if (match) {
        return {
            artist: match[1].trim(),
            title: match[2].trim().replace(/\s*[\(\[]\d{4}[\)\]]\s*$/, '').trim(),
        };
    }
    return { artist: '', title: raw };
}

// ─── Public API ───────────────────────────────────────────────────────────────
export const channelService = {
    // Pre-load the first batch of videos for all channels in parallel.
    // Errors per channel are swallowed so one bad channel can't block the others.
    async init() {
        await Promise.all(
            CHANNEL_HANDLES.map(h => loadMoreVideos(h).catch(err =>
                console.warn(`channelService.init: failed for ${h}:`, err)
            ))
        );
    },

    // Returns true if at least one channel has videos ready
    hasAnyVideos() {
        return CHANNEL_HANDLES.some(h => (cache[h]?.videos?.length ?? 0) > 0);
    },

    async fetchRandomVideo() {
        const handle = CHANNEL_HANDLES[Math.floor(Math.random() * CHANNEL_HANDLES.length)];
        _ensureCache(handle);

        if (cache[handle].videos.length === 0) {
            try {
                await loadMoreVideos(handle);
            } catch (err) {
                console.warn(`fetchRandomVideo: loadMoreVideos failed for ${handle}:`, err);
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

        // Background-fetch more if pool is running low
        if ((pool.length - seenVideos.size) < 20) loadMoreVideos(handle).catch(() => {});

        const snippet = item.snippet || {};
        const { artist, title } = parseTitle(snippet.title || '');
        const q = encodeURIComponent([artist, title].filter(Boolean).join(' '));

        return {
            releaseId: videoId,
            title: title || snippet.title || '',
            artist: artist || snippet.channelTitle || handle,
            year: (snippet.publishedAt || '').slice(0, 4),
            category: snippet.channelTitle || handle,
            coverUrl: snippet.thumbnails?.high?.url || snippet.thumbnails?.medium?.url || '',
            discogsUrl: `https://www.discogs.com/search/?q=${q}&type=release`,
            youtubeVideoIds: [videoId],
            youtubePlaylistId: null,
            trackList: [],
            isChannelMode: true,
        };
    },

    clearSession() {
        seenVideos.clear();
    },
};
