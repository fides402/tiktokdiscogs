import { CONFIG } from '../config.js';

const CHANNEL_HANDLES = [
    'VinyleArcheologie',
    'oleg_samples',
    'librariessountracksandrelated',
    'andrenavarroII',
];

// Per-channel runtime state
const cache = {};
const seenVideos = new Set();

async function ytFetch(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`YouTube API ${res.status}`);
    return res.json();
}

// Uses the same search?type=video endpoint that works in Discogs mode.
// No channel ID lookup required — avoids the broken channels.list endpoint.
async function loadMoreVideos(handle) {
    if (!cache[handle]) {
        cache[handle] = { videos: [], nextPageToken: undefined, loading: false, exhausted: false };
    }
    const ch = cache[handle];
    if (ch.loading || ch.exhausted) return;
    ch.loading = true;
    try {
        let url = `${CONFIG.YOUTUBE_BASE_URL}/search?part=snippet&q=${encodeURIComponent(handle)}&type=video&order=date&maxResults=50&key=${CONFIG.YOUTUBE_API_KEY}`;
        if (ch.nextPageToken) url += `&pageToken=${ch.nextPageToken}`;
        const data = await ytFetch(url);
        const items = (data.items || [])
            .filter(item => item.id?.videoId)
            .map(item => ({
                contentDetails: { videoId: item.id.videoId },
                snippet: item.snippet,
            }));
        ch.videos.push(...items);
        if (data.nextPageToken) {
            ch.nextPageToken = data.nextPageToken;
        } else {
            ch.exhausted = true;
        }
    } finally {
        ch.loading = false;
    }
}

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

export const channelService = {
    async init() {
        await Promise.all(
            CHANNEL_HANDLES.map(h => loadMoreVideos(h).catch(err =>
                console.warn(`channelService.init: failed for ${h}:`, err)
            ))
        );
    },

    hasAnyVideos() {
        return CHANNEL_HANDLES.some(h => (cache[h]?.videos?.length ?? 0) > 0);
    },

    async fetchRandomVideo() {
        const handle = CHANNEL_HANDLES[Math.floor(Math.random() * CHANNEL_HANDLES.length)];
        if (!cache[handle] || cache[handle].videos.length === 0) {
            try {
                await loadMoreVideos(handle);
            } catch (err) {
                console.warn(`fetchRandomVideo: load failed for ${handle}:`, err);
                return null;
            }
        }

        const pool = cache[handle]?.videos ?? [];
        if (!pool.length) return null;

        const unseen = pool.filter(v => !seenVideos.has(v.contentDetails.videoId));
        const candidates = unseen.length ? unseen : pool;
        const item = candidates[Math.floor(Math.random() * candidates.length)];
        const videoId = item.contentDetails.videoId;

        seenVideos.add(videoId);
        if (seenVideos.size > 500) seenVideos.delete(seenVideos.values().next().value);

        // Pre-fetch next page in background when pool runs low
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
