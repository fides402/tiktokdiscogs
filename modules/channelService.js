/**
 * channelService — fetches videos from curated YouTube channels.
 *
 * Strategy (zero load time, full randomness):
 *   1. Initial load from `localStorage` (instant).
 *   2. If empty, fetch RSS to get 15 videos immediately (instant, 0 quota).
 *   3. In background, smoothly paginate YouTube API until the ENTIRE channel 
 *      history is saved to `localStorage`.
 *   4. Select randomly from the full local history (true randomness).
 */
import { CONFIG } from '../config.js';

const CHANNELS = [
    { handle: 'VinyleArcheologie', channelId: 'UCKydEBEvAU5zkN8o1snt62A' },
    { handle: 'oleg_samples', channelId: 'UC47qc6t2RelhfvI-OjgIY2A' },
    { handle: 'librariessountracksandrelated', channelId: 'UCekevJPGTZ44nn_i4SWJDIw' },
    { handle: 'andrenavarroII', channelId: 'UCv5OAW45h67CJEY6kJLyisg' },
];

const uploadsId = ch => 'UU' + ch.channelId.slice(2);

const cache = {}; // handle -> { videos: [], nextPageToken: null, isFullyLoaded: false, isSyncing: false }
const seenVideos = new Set();

// ─── Cache Management ─────────────────────────────────────────────────────────

function _ensureCache(handle) {
    if (!cache[handle]) {
        try {
            const stored = localStorage.getItem(`channel_${handle}`);
            if (stored) {
                cache[handle] = JSON.parse(stored);
                // Fix for old cache format
                if (!cache[handle].videos) cache[handle].videos = [];
            } else {
                cache[handle] = { videos: [], nextPageToken: null, isFullyLoaded: false, isSyncing: false };
            }
        } catch (e) {
            cache[handle] = { videos: [], nextPageToken: null, isFullyLoaded: false, isSyncing: false };
        }
        cache[handle].isSyncing = false; // Reset on load
    }
}

function _saveCache(handle) {
    if (cache[handle]) {
        try {
            localStorage.setItem(`channel_${handle}`, JSON.stringify({
                videos: cache[handle].videos,
                nextPageToken: cache[handle].nextPageToken,
                isFullyLoaded: cache[handle].isFullyLoaded
            }));
        } catch (e) { /* ignore quota/storage errors */ }
    }
}

// ─── RSS Quick Fetch (for instant startup if empty) ───────────────────────────

async function fetchRssForInstantStart(ch) {
    const state = cache[ch.handle];
    try {
        const res = await fetch(`/api/yt-rss/${ch.channelId}`);
        if (!res.ok) return false;
        const xml = await res.text();
        const doc = new DOMParser().parseFromString(xml, 'application/xml');
        if (doc.querySelector('parsererror')) return false;

        const channelTitle = doc.querySelector('author name')?.textContent || '';
        const items = Array.from(doc.querySelectorAll('entry')).map(entry => {
            const idText = entry.querySelector('id')?.textContent || '';
            const videoId = idText.startsWith('yt:video:') ? idText.slice(9) : null;
            if (!videoId) return null;
            return {
                contentDetails: { videoId },
                snippet: {
                    title: entry.querySelector('title')?.textContent || '',
                    publishedAt: entry.querySelector('published')?.textContent || '',
                    channelTitle,
                    thumbnails: { high: { url: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` } },
                },
            };
        }).filter(Boolean);

        const existingIds = new Set(state.videos.map(v => v.contentDetails.videoId));
        const newItems = items.filter(v => !existingIds.has(v.contentDetails.videoId));

        if (newItems.length > 0) {
            state.videos.push(...newItems);
            _saveCache(ch.handle);
        }
        return true;
    } catch (e) {
        return false;
    }
}

// ─── YouTube Data API Background Sync ─────────────────────────────────────────

async function loadPlaylistPage(ch) {
    const pid = uploadsId(ch);
    const state = cache[ch.handle];

    let url = `${CONFIG.YOUTUBE_BASE_URL}/playlistItems?part=snippet,contentDetails&playlistId=${pid}&maxResults=50&key=${CONFIG.YOUTUBE_API_KEY}`;
    if (state.nextPageToken) url += `&pageToken=${state.nextPageToken}`;

    const res = await fetch(url);
    if (!res.ok) {
        if (res.status === 403 || res.status === 400) {
            state.isFullyLoaded = true; // API key error or quota exceeded, stop trying forever
            _saveCache(ch.handle);
        }
        throw new Error(`YT API ${res.status}`);
    }
    const data = await res.json();

    const items = (data.items || []).map(item => {
        const vid = item.contentDetails?.videoId;
        const title = item.snippet?.title;
        if (!vid || title === 'Deleted video' || title === 'Private video') return null;

        return {
            contentDetails: { videoId: vid },
            snippet: {
                title: title,
                publishedAt: item.snippet?.publishedAt || '',
                channelTitle: item.snippet?.channelTitle || ch.handle,
                thumbnails: { high: { url: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg` } }
            }
        };
    }).filter(Boolean);

    // De-duplicate
    const existingIds = new Set(state.videos.map(v => v.contentDetails.videoId));
    const newItems = items.filter(v => !existingIds.has(v.contentDetails.videoId));

    state.videos.push(...newItems);
    state.nextPageToken = data.nextPageToken || null;
    if (!state.nextPageToken) {
        state.isFullyLoaded = true;
    }

    _saveCache(ch.handle);
}

async function scrapeChannelInBackground(ch) {
    _ensureCache(ch.handle);
    const state = cache[ch.handle];
    if (state.isSyncing || state.isFullyLoaded) return;
    state.isSyncing = true;

    try {
        while (!state.isFullyLoaded) {
            await loadPlaylistPage(ch);
            await new Promise(r => setTimeout(r, 1000)); // Be nice to the API, step softly
        }
    } catch (err) {
        console.warn(`[channelService] background sync paused for ${ch.handle}`);
    } finally {
        state.isSyncing = false;
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
        // Prepare caches instantly
        CHANNELS.forEach(ch => _ensureCache(ch.handle));

        // Start background synchronization to archive the channel (non-blocking)
        CHANNELS.forEach(ch => scrapeChannelInBackground(ch).catch(() => { }));

        // If caches are completely empty right now, fetch RSS once to get going instantly
        const emptyChannels = CHANNELS.filter(ch => cache[ch.handle].videos.length === 0);
        if (emptyChannels.length > 0) {
            await Promise.all(emptyChannels.map(ch => fetchRssForInstantStart(ch)));
        }
    },

    hasAnyVideos() {
        return CHANNELS.some(ch => (cache[ch.handle]?.videos?.length ?? 0) > 0);
    },

    async fetchRandomVideo() {
        // Pick among channels that possess videos 
        const readyChannels = CHANNELS.filter(ch => cache[ch.handle] && cache[ch.handle].videos.length > 0);
        if (readyChannels.length === 0) return null;

        const ch = readyChannels[Math.floor(Math.random() * readyChannels.length)];
        const pool = cache[ch.handle].videos;

        const unseen = pool.filter(v => !seenVideos.has(v.contentDetails.videoId));
        const candidates = unseen.length ? unseen : pool;
        const item = candidates[Math.floor(Math.random() * candidates.length)];
        const videoId = item.contentDetails.videoId;

        seenVideos.add(videoId);
        if (seenVideos.size > 2000) seenVideos.delete(seenVideos.values().next().value);

        const snippet = item.snippet || {};
        const { artist, title } = parseTitle(snippet.title || '');
        const q = encodeURIComponent([artist, title].filter(Boolean).join(' '));

        return {
            releaseId: videoId,
            title: title || snippet.title || '',
            artist: artist || snippet.channelTitle || ch.handle,
            year: (snippet.publishedAt || '').slice(0, 4),
            category: snippet.channelTitle || ch.handle,
            coverUrl: snippet.thumbnails?.high?.url || '',
            discogsUrl: `https://www.discogs.com/search/?q=${q}&type=release`,
            youtubeVideoIds: [videoId],
            youtubePlaylistId: null,
            trackList: [],
            isChannelMode: true,
        };
    },

    // seenVideos is intentionally NOT cleared here: same reason as discogsService.
    // Keeping it persistent across back-and-forth navigations prevents the same
    // videos from cycling back immediately. The set auto-rotates at 2 000 entries.
    clearSession() {},
};
